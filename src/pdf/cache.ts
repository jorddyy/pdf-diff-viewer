// Local cache of analysed documents (IndexedDB, this browser only), keyed by
// the SHA-256 of the PDF. Every operation is best-effort: private windows or
// blocked storage simply mean no cache.
import type { DocModel } from '../extract/types';

/** Bump when extraction output changes so stale entries are ignored. */
export const EXTRACT_VERSION = 2;
const DB = 'pdf-diff-cache';
const STORE = 'docs';
const MAX_ENTRIES = 30;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
}

interface Entry {
  doc: DocModel;
  at: number;
}

/** Result of one figure comparison, as shown in the change list. */
export interface FigureResult {
  status: 'changed' | 'identical';
  diffs: (number | null)[];
}

interface FigureEntry {
  figures: Record<string, FigureResult>;
  at: number;
}

export async function getCached(hash: string): Promise<DocModel | null> {
  try {
    const e = (await tx('readonly', (s) => s.get(`${EXTRACT_VERSION}:${hash}`))) as Entry | undefined;
    return e?.doc ?? null;
  } catch {
    return null;
  }
}

export async function putCached(hash: string, doc: DocModel): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put({ doc, at: Date.now() } satisfies Entry, `${EXTRACT_VERSION}:${hash}`));
    const keys = (await tx('readonly', (s) => s.getAllKeys())) as string[];
    if (keys.length > MAX_ENTRIES) {
      const entries = await Promise.all(keys.map(async (k) => [k, ((await tx('readonly', (s) => s.get(k))) as Entry).at] as const));
      entries.sort((a, b) => a[1] - b[1]);
      for (const [k] of entries.slice(0, keys.length - MAX_ENTRIES)) await tx('readwrite', (s) => s.delete(k));
    }
  } catch {
    // Storage unavailable or full: run without cache.
  }
}

/**
 * Figure comparison results of one pair of PDFs, keyed by the compared regions
 * (see `figureKey` in app.tsx). Rendering every changed figure takes minutes for
 * large notes, so reopening a comparison reuses them. `version` is
 * `COMPARE_VERSION`, bumped when rendering or the ink comparison changes.
 */
export async function getFigureResults(version: number, hashA: string, hashB: string): Promise<Record<string, FigureResult>> {
  try {
    const e = (await tx('readonly', (s) => s.get(`fig${version}:${hashA}:${hashB}`))) as FigureEntry | undefined;
    return e?.figures ?? {};
  } catch {
    return {};
  }
}

export async function putFigureResults(version: number, hashA: string, hashB: string, figures: Record<string, FigureResult>): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put({ figures, at: Date.now() } satisfies FigureEntry, `fig${version}:${hashA}:${hashB}`));
  } catch {
    // Storage unavailable or full: figures are compared again next time.
  }
}

export async function clearCache(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.clear());
  } catch {
    // ignore
  }
}
