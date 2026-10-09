// Saved comparisons ("workspaces") and the PDFs they use, in IndexedDB. Local
// to this browser; nothing leaves it. PDFs are stored once per SHA-256.

const DB = 'pdf-diff-workspaces';
const FILES = 'files';
const SPACES = 'workspaces';
/** Older comparisons beyond this are dropped, with PDFs no longer used. */
const MAX_WORKSPACES = 15;

export interface WorkspaceVersion {
  hash: string;
  name: string;
  label: string;
}

export interface SavedPos {
  page: number;
  y: number;
}

export interface Workspace {
  id: string;
  title: string;
  /** The user renamed it; stop deriving the title from the files. */
  customTitle: boolean;
  created: number;
  updated: number;
  versions: WorkspaceVersion[];
  /** Hashes of the compared pair. */
  left: string | null;
  right: string | null;
  pairChosen: boolean;
  filters: Record<string, boolean>;
  zoom: number | null;
  sync: boolean;
  tab: 'changes' | 'contents' | 'comments';
  scroll: { a: SavedPos | null; b: SavedPos | null };
  comments: string;
  /** Review round → version hash (only rounds the user changed). */
  roundOverride: [number, string | null][];
  /** Figure/table/equation pairings chosen by the user, per "oldHash:newHash". */
  pairOverrides?: Record<string, { kind: 'figure' | 'table' | 'equation'; a: string | null; b: string | null }[]>;
  done: string[];
}

interface StoredFile {
  bytes: ArrayBuffer;
  name: string;
  at: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(FILES);
      req.result.createObjectStore(SPACES, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : (undefined as T));
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const all = (await run<Workspace[]>(SPACES, 'readonly', (s) => s.getAll())) ?? [];
  return all.filter((w) => w.versions.length).sort((a, b) => b.updated - a.updated);
}

export async function saveWorkspace(ws: Workspace): Promise<void> {
  await run(SPACES, 'readwrite', (s) => s.put(ws));
  const all = await listWorkspaces();
  for (const old of all.slice(MAX_WORKSPACES)) await deleteWorkspace(old.id);
}

export async function deleteWorkspace(id: string): Promise<void> {
  await run(SPACES, 'readwrite', (s) => s.delete(id));
  await collectFiles();
}

export async function putFile(hash: string, bytes: ArrayBuffer, name: string): Promise<void> {
  const have = await run<IDBValidKey | undefined>(FILES, 'readonly', (s) => s.getKey(hash));
  if (have !== undefined) return;
  await run(FILES, 'readwrite', (s) => s.put({ bytes, name, at: Date.now() } satisfies StoredFile, hash));
}

export async function getFile(hash: string): Promise<{ bytes: ArrayBuffer; name: string } | null> {
  const f = await run<StoredFile | undefined>(FILES, 'readonly', (s) => s.get(hash));
  return f ? { bytes: f.bytes, name: f.name } : null;
}

/** Drop stored PDFs that no saved comparison uses any more. */
async function collectFiles(): Promise<void> {
  const used = new Set((await listWorkspaces()).flatMap((w) => w.versions.map((v) => v.hash)));
  const keys = (await run<IDBValidKey[]>(FILES, 'readonly', (s) => s.getAllKeys())) ?? [];
  for (const k of keys) if (!used.has(String(k))) await run(FILES, 'readwrite', (s) => s.delete(k));
}

export async function clearWorkspaces(): Promise<void> {
  await run(SPACES, 'readwrite', (s) => s.clear());
  await run(FILES, 'readwrite', (s) => s.clear());
}

/** "LHCb-ANA-2099-001 · v2.0 → v3.0": common file-name stem plus the compared labels. */
export function workspaceTitle(versions: WorkspaceVersion[], left: string | null, right: string | null): string {
  const stem = (n: string) =>
    n
      .replace(/\.pdf$/i, '')
      .replace(/[-_ ]?v?\d+([._]\d+)*$/i, '')
      .replace(/[-_ ]+$/, '');
  const stems = versions.map((v) => stem(v.name)).filter(Boolean);
  let base = stems[0] ?? 'Comparison';
  // Prefer a stem shared by several files (the official name, not an export name).
  const counts = new Map<string, number>();
  for (const s of stems) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const [s, c] of counts) if (c > (counts.get(base) ?? 0)) base = s;
  const l = versions.find((v) => v.hash === left)?.label;
  const r = versions.find((v) => v.hash === right)?.label;
  return l && r ? `${base} · ${l} → ${r}` : base;
}
