// A small, read-only PDF reader that finds where each page places its Form
// XObjects and images (q/Q/cm/Do), plus thin rules, without interpreting the
// figures themselves. pdf.js would parse every vector plot completely to give
// the same information, which dominates the analysis time of plot-heavy notes.
// It also fingerprints each placed XObject, so identical figures are
// recognised without rendering. Anything unexpected throws; callers then fall
// back to pdf.js.

export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

export interface Ref {
  num: number;
  gen: number;
}
type PdfObj = number | string | boolean | null | Name | Ref | PdfObj[] | Dict | Stream;
export class Name {
  constructor(readonly name: string) {}
}
export type Dict = Map<string, PdfObj>;
export interface Stream {
  dict: Dict;
  raw: Uint8Array;
}

/** Rects are in PDF user space: [x0, y0, x1, y1] with y up. */
export interface ScannedGraphic {
  rect: [number, number, number, number];
  kind: 'form' | 'image';
  hash: string;
}

export interface ScannedPage {
  graphics: ScannedGraphic[];
  rules: [number, number, number, number][];
}

type Matrix = [number, number, number, number, number, number];

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const isRef = (o: unknown): o is Ref => typeof o === 'object' && o !== null && !(o instanceof Map) && 'num' in o && 'gen' in o;
const isStream = (o: unknown): o is Stream => typeof o === 'object' && o !== null && 'raw' in o && 'dict' in o;
const nameOf = (o: unknown) => (o instanceof Name ? o.name : null);

class Lexer {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    pos = 0,
  ) {
    this.pos = pos;
  }

  skipWs(): void {
    const b = this.buf;
    for (;;) {
      while (this.pos < b.length && WS[b[this.pos]]) this.pos++;
      if (b[this.pos] === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else return;
    }
  }

  /** Next token: a parsed primitive, or a {kw} for keywords and delimiters. */
  next(): PdfObj | { kw: string } | undefined {
    this.skipWs();
    const b = this.buf;
    if (this.pos >= b.length) return undefined;
    const c = b[this.pos];
    if (c === 0x2f) {
      // /Name
      let s = '';
      this.pos++;
      while (this.pos < b.length && !WS[b[this.pos]] && !DELIM[b[this.pos]]) {
        if (b[this.pos] === 0x23 && this.pos + 2 < b.length) {
          s += String.fromCharCode(parseInt(String.fromCharCode(b[this.pos + 1], b[this.pos + 2]), 16));
          this.pos += 3;
        } else s += String.fromCharCode(b[this.pos++]);
      }
      return new Name(s);
    }
    if (c === 0x28) return this.literalString();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { kw: '<<' };
      }
      const end = b.indexOf(0x3e, this.pos);
      if (end < 0) throw new Error('unterminated hex string');
      this.pos = end + 1;
      return '';
    }
    if (c === 0x3e && b[this.pos + 1] === 0x3e) {
      this.pos += 2;
      return { kw: '>>' };
    }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      this.pos++;
      return { kw: String.fromCharCode(c) };
    }
    const start = this.pos;
    while (this.pos < b.length && !WS[b[this.pos]] && !DELIM[b[this.pos]]) this.pos++;
    if (this.pos === start) {
      this.pos++;
      return { kw: String.fromCharCode(c) };
    }
    const tok = latin1(b, start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return parseFloat(tok);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return { kw: tok };
  }

  private literalString(): string {
    const b = this.buf;
    let depth = 0;
    const start = this.pos;
    for (; this.pos < b.length; this.pos++) {
      const c = b[this.pos];
      if (c === 0x5c) this.pos++;
      else if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) {
        this.pos++;
        return latin1(b, start + 1, this.pos - 1);
      }
    }
    throw new Error('unterminated string');
  }

  /** Parse one object; numbers followed by "gen R" become references. */
  object(tok = this.next()): PdfObj {
    if (tok === undefined) throw new Error('unexpected end of data');
    if (typeof tok === 'number' && Number.isInteger(tok)) {
      const save = this.pos;
      const t2 = this.next();
      if (typeof t2 === 'number' && Number.isInteger(t2)) {
        const t3 = this.next();
        if (isKw(t3, 'R')) return { num: tok, gen: t2 };
      }
      this.pos = save;
      return tok;
    }
    if (isKw(tok, '[')) {
      const arr: PdfObj[] = [];
      for (;;) {
        const t = this.next();
        if (isKw(t, ']')) return arr;
        arr.push(this.object(t));
      }
    }
    if (isKw(tok, '<<')) {
      const d: Dict = new Map();
      for (;;) {
        const k = this.next();
        if (isKw(k, '>>')) return d;
        const key = nameOf(k);
        if (key === null) throw new Error('bad dictionary key');
        d.set(key, this.object());
      }
    }
    if (typeof tok === 'object' && tok !== null && 'kw' in tok) throw new Error(`unexpected ${tok.kw}`);
    return tok as PdfObj;
  }
}

function isKw(t: unknown, kw: string): boolean {
  return typeof t === 'object' && t !== null && (t as { kw?: string }).kw === kw;
}

function latin1(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
  return out;
}

type XrefEntry = { type: 1; offset: number } | { type: 2; stream: number; index: number };

export class PdfFile {
  private xref = new Map<number, XrefEntry>();
  private cache = new Map<number, PdfObj>();
  private objStms = new Map<number, Promise<{ data: Uint8Array; offsets: Map<number, number> }>>();
  trailer: Dict = new Map();

  private constructor(
    readonly buf: Uint8Array,
    readonly inflate: Inflate,
  ) {}

  static async open(buf: Uint8Array, inflate: Inflate): Promise<PdfFile> {
    const f = new PdfFile(buf, inflate);
    try {
      await f.readXref();
    } catch {
      f.reconstructXref();
    }
    if (!f.trailer.get('Root')) f.reconstructXref();
    return f;
  }

  private async readXref(): Promise<void> {
    const tail = latin1(this.buf, Math.max(0, this.buf.length - 2048), this.buf.length);
    const m = /startxref\s+(\d+)/g;
    let last: RegExpExecArray | null = null;
    for (let r; (r = m.exec(tail)); ) last = r;
    if (!last) throw new Error('no startxref');
    const seen = new Set<number>();
    let offset: number | null = +last[1];
    while (offset !== null && !seen.has(offset)) {
      seen.add(offset);
      const lx = new Lexer(this.buf, offset);
      const t = lx.next();
      let dict: Dict;
      if (isKw(t, 'xref')) {
        dict = this.readXrefTable(lx);
        const stm = dict.get('XRefStm');
        if (typeof stm === 'number') await this.readXrefStream(stm);
      } else dict = await this.readXrefStream(offset);
      for (const [k, v] of dict) if (!this.trailer.has(k)) this.trailer.set(k, v);
      const prev = dict.get('Prev');
      offset = typeof prev === 'number' ? prev : null;
    }
  }

  private readXrefTable(lx: Lexer): Dict {
    for (;;) {
      const t = lx.next();
      if (isKw(t, 'trailer')) return lx.object() as Dict;
      const start = t as number;
      const count = lx.next() as number;
      for (let i = 0; i < count; i++) {
        const off = lx.next() as number;
        lx.next(); // generation
        const kind = lx.next() as { kw: string };
        const num = start + i;
        if (kind.kw === 'n' && !this.xref.has(num)) this.xref.set(num, { type: 1, offset: off });
      }
    }
  }

  private async readXrefStream(offset: number): Promise<Dict> {
    const obj = this.parseIndirectAt(offset);
    if (!isStream(obj)) throw new Error('xref stream expected');
    const data = await this.decode(obj);
    const w = (obj.dict.get('W') as number[]).map(Number);
    const size = obj.dict.get('Size') as number;
    const index = (obj.dict.get('Index') as number[] | undefined) ?? [0, size];
    const rowLen = w[0] + w[1] + w[2];
    let pos = 0;
    const field = (n: number) => {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + data[pos++];
      return v;
    };
    for (let s = 0; s < index.length; s += 2) {
      for (let i = 0; i < index[s + 1]; i++) {
        if (pos + rowLen > data.length) break;
        const type = w[0] ? field(w[0]) : 1;
        const f2 = field(w[1]);
        const f3 = field(w[2]);
        const num = index[s] + i;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { type: 1, offset: f2 });
        else if (type === 2) this.xref.set(num, { type: 2, stream: f2, index: f3 });
      }
    }
    return obj.dict;
  }

  /** Damaged cross-reference: find "n g obj" headers by scanning the file. */
  private reconstructXref(): void {
    this.xref.clear();
    const text = latin1(this.buf, 0, this.buf.length);
    const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
    for (let m; (m = re.exec(text)); ) this.xref.set(+m[1], { type: 1, offset: m.index + m[0].indexOf(m[1]) });
    const tr = /trailer\s*<</g;
    for (let m; (m = tr.exec(text)); ) {
      const d = new Lexer(this.buf, m.index + 7).object() as Dict;
      for (const [k, v] of d) this.trailer.set(k, v);
    }
    if (!this.trailer.get('Root')) {
      // Cross-reference streams only: find the catalogue directly.
      const cat = /(\d+)\s+0\s+obj\s*<<[^>]*\/Type\s*\/Catalog/.exec(text);
      if (cat) this.trailer.set('Root', { num: +cat[1], gen: 0 });
    }
  }

  private parseIndirectAt(offset: number): PdfObj {
    const lx = new Lexer(this.buf, offset);
    lx.next();
    lx.next();
    if (!isKw(lx.next(), 'obj')) throw new Error('obj expected');
    const obj = lx.object();
    if (obj instanceof Map) {
      lx.skipWs();
      const save = lx.pos;
      if (isKw(lx.next(), 'stream')) {
        let start = lx.pos;
        if (this.buf[start] === 13) start++;
        if (this.buf[start] === 10) start++;
        let len = obj.get('Length');
        if (isRef(len)) len = this.getSync(len.num) as number;
        let end = typeof len === 'number' ? start + len : -1;
        if (end < 0 || end > this.buf.length || latin1(this.buf, end, Math.min(end + 20, this.buf.length)).indexOf('endstream') < 0) {
          end = indexOfStr(this.buf, 'endstream', start);
          while (end > start && (this.buf[end - 1] === 10 || this.buf[end - 1] === 13)) end--;
        }
        return { dict: obj, raw: this.buf.subarray(start, end) };
      }
      lx.pos = save;
    }
    return obj;
  }

  /** Objects stored directly in the file (needed synchronously for /Length). */
  private getSync(num: number): PdfObj {
    const e = this.xref.get(num);
    if (!e || e.type !== 1) return null;
    return this.parseIndirectAt(e.offset);
  }

  async get(num: number): Promise<PdfObj> {
    if (this.cache.has(num)) return this.cache.get(num)!;
    const e = this.xref.get(num);
    let obj: PdfObj = null;
    if (e?.type === 1) obj = this.parseIndirectAt(e.offset);
    else if (e?.type === 2) {
      let stm = this.objStms.get(e.stream);
      if (!stm) {
        stm = (async () => {
          const s = await this.get(e.stream);
          if (!isStream(s)) throw new Error('object stream expected');
          const data = await this.decode(s);
          const n = s.dict.get('N') as number;
          const first = s.dict.get('First') as number;
          const lx = new Lexer(data);
          const offsets = new Map<number, number>();
          for (let i = 0; i < n; i++) offsets.set(lx.next() as number, first + (lx.next() as number));
          return { data, offsets };
        })();
        this.objStms.set(e.stream, stm);
      }
      const { data, offsets } = await stm;
      const off = offsets.get(num);
      if (off !== undefined) obj = new Lexer(data, off).object();
    }
    this.cache.set(num, obj);
    return obj;
  }

  async resolve(o: PdfObj | undefined): Promise<PdfObj> {
    let cur: PdfObj | undefined = o;
    for (let i = 0; i < 8 && isRef(cur); i++) cur = await this.get(cur.num);
    return cur ?? null;
  }

  async decode(s: Stream): Promise<Uint8Array> {
    const filters = await this.resolve(s.dict.get('Filter'));
    const parms = await this.resolve(s.dict.get('DecodeParms'));
    const fl = Array.isArray(filters) ? filters : filters ? [filters] : [];
    const pl = Array.isArray(parms) ? parms : [parms];
    let data = s.raw;
    for (let i = 0; i < fl.length; i++) {
      const f = nameOf(await this.resolve(fl[i]));
      if (f !== 'FlateDecode' && f !== 'Fl') throw new Error(`unsupported filter ${f}`);
      data = await this.inflate(data);
      const p = (await this.resolve(pl[i] ?? null)) as Dict | null;
      const pred = p instanceof Map ? (p.get('Predictor') as number) : 1;
      if (pred && pred >= 10) data = unpredictPng(data, (p!.get('Columns') as number) ?? 1, (p!.get('Colors') as number) ?? 1, (p!.get('BitsPerComponent') as number) ?? 8);
      else if (pred === 2) throw new Error('TIFF predictor not supported');
    }
    return data;
  }

  /** Page objects in order, with inherited resources and boxes. */
  async pages(): Promise<{ dict: Dict; resources: Dict }[]> {
    const root = (await this.resolve(this.trailer.get('Root'))) as Dict;
    const out: { dict: Dict; resources: Dict }[] = [];
    const walk = async (node: Dict, resources: Dict, depth: number) => {
      if (depth > 50) throw new Error('page tree too deep');
      const res = ((await this.resolve(node.get('Resources'))) as Dict | null) ?? resources;
      const kids = await this.resolve(node.get('Kids'));
      if (nameOf(node.get('Type')) === 'Pages' || Array.isArray(kids)) {
        for (const k of (kids as PdfObj[]) ?? []) await walk((await this.resolve(k)) as Dict, res, depth + 1);
      } else out.push({ dict: node, resources: res });
    };
    await walk((await this.resolve(root.get('Pages'))) as Dict, new Map(), 0);
    return out;
  }

  async contents(page: Dict): Promise<Uint8Array> {
    const c = await this.resolve(page.get('Contents'));
    const parts = Array.isArray(c) ? await Promise.all(c.map((x) => this.resolve(x))) : [c];
    const datas: Uint8Array[] = [];
    for (const p of parts) if (isStream(p)) datas.push(await this.decode(p));
    const total = datas.reduce((n, d) => n + d.length + 1, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const d of datas) {
      all.set(d, o);
      o += d.length;
      all[o++] = 10;
    }
    return all;
  }

  /** Stable fingerprint of an XObject: its raw bytes plus the XObjects it uses, recursively. */
  async fingerprint(s: Stream, depth = 0): Promise<string> {
    let h = hashBytes(s.raw);
    if (depth < 3) {
      const res = (await this.resolve(s.dict.get('Resources'))) as Dict | null;
      const xo = res instanceof Map ? ((await this.resolve(res.get('XObject'))) as Dict | null) : null;
      if (xo instanceof Map) {
        for (const [, ref] of [...xo].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          const sub = await this.resolve(ref);
          if (isStream(sub)) h += ':' + (await this.fingerprint(sub, depth + 1));
        }
      }
    }
    return depth === 0 ? hashString(h) : h;
  }
}

function indexOfStr(buf: Uint8Array, s: string, from: number): number {
  const first = s.charCodeAt(0);
  outer: for (let i = buf.indexOf(first, from); i >= 0 && i < buf.length; i = buf.indexOf(first, i + 1)) {
    for (let k = 1; k < s.length; k++) if (buf[i + k] !== s.charCodeAt(k)) continue outer;
    return i;
  }
  return buf.length;
}

function unpredictPng(data: Uint8Array, columns: number, colors: number, bpc: number): Uint8Array {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r ? out[dst - rowLen + i] : 0;
      const upLeft = r && i >= bpp ? out[dst - rowLen + i - bpp] : 0;
      let v: number;
      switch (type) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + left;
          break;
        case 2:
          v = x + up;
          break;
        case 3:
          v = x + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error('bad PNG predictor');
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

/** cyrb53-style 53-bit hash, as hex. */
export function hashBytes(b: Uint8Array): string {
  let h1 = 0xdeadbeef ^ b.length;
  let h2 = 0x41c6ce57 ^ b.length;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 2654435761);
    h2 = Math.imul(h2 ^ b[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function hashString(s: string): string {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return hashBytes(b);
}

function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function rectThrough(m: Matrix, r: number[]): [number, number, number, number] {
  const pts = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[0], r[3]],
    [r[2], r[3]],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Interpret one page's content stream for XObject placements and thin rules. */
export async function scanPage(file: PdfFile, page: { dict: Dict; resources: Dict }): Promise<ScannedPage> {
  const data = await file.contents(page.dict);
  const xobjects = (await file.resolve(page.resources.get('XObject'))) as Dict | null;
  const lx = new Lexer(data);
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let operands: PdfObj[] = [];
  let path: number[] | null = null; // local bbox of the current path
  const graphics: ScannedGraphic[] = [];
  const rules: [number, number, number, number][] = [];
  const addPt = (x: number, y: number) => {
    if (!path) path = [x, y, x, y];
    else path = [Math.min(path[0], x), Math.min(path[1], y), Math.max(path[2], x), Math.max(path[3], y)];
  };
  for (;;) {
    const t = lx.next();
    if (t === undefined) break;
    if (!(typeof t === 'object' && t !== null && 'kw' in t)) {
      operands.push(t);
      continue;
    }
    if (t.kw === '[' || t.kw === '<<') {
      operands.push(lx.object(t));
      continue;
    }
    const op = t.kw;
    const n = operands as number[];
    switch (op) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case 'cm':
        if (n.length >= 6) ctm = mul(n.slice(-6) as Matrix, ctm);
        break;
      case 'Do': {
        const name = nameOf(operands[operands.length - 1]);
        const ref = name && xobjects instanceof Map ? xobjects.get(name) : undefined;
        const xo = await file.resolve(ref);
        if (isStream(xo)) {
          const sub = nameOf(xo.dict.get('Subtype'));
          if (sub === 'Form') {
            const bbox = ((await file.resolve(xo.dict.get('BBox'))) as number[]) ?? [0, 0, 1, 1];
            const mtx = ((await file.resolve(xo.dict.get('Matrix'))) as Matrix | null) ?? [1, 0, 0, 1, 0, 0];
            graphics.push({ rect: rectThrough(mul(mtx, ctm), bbox), kind: 'form', hash: await file.fingerprint(xo) });
          } else if (sub === 'Image') {
            graphics.push({ rect: rectThrough(ctm, [0, 0, 1, 1]), kind: 'image', hash: await file.fingerprint(xo) });
          }
        }
        break;
      }
      case 'BI': {
        // Inline image: skip its data up to EI.
        const ei = indexOfStr(data, 'EI', lx.pos);
        lx.pos = ei + 2;
        graphics.push({ rect: rectThrough(ctm, [0, 0, 1, 1]), kind: 'image', hash: 'inline' });
        break;
      }
      case 're':
        if (n.length >= 4) {
          const [x, y, w, h] = n.slice(-4);
          addPt(x, y);
          addPt(x + w, y + h);
        }
        break;
      case 'm':
      case 'l':
        if (n.length >= 2) addPt(n[n.length - 2], n[n.length - 1]);
        break;
      case 'c':
        if (n.length >= 6) {
          addPt(n[n.length - 6], n[n.length - 5]);
          addPt(n[n.length - 2], n[n.length - 1]);
        }
        break;
      case 'v':
      case 'y':
        if (n.length >= 4) addPt(n[n.length - 2], n[n.length - 1]);
        break;
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
      case 'n':
        if (path && op !== 'n') {
          const r = rectThrough(ctm, path);
          if (r[3] - r[1] <= 2 && r[2] - r[0] >= 20) rules.push(r);
        }
        path = null;
        break;
    }
    operands = [];
  }
  return { graphics, rules };
}
