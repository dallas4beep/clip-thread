"use client";

/**
 * IndexedDB persistence for recorded segments, so an upload can resume after
 * a reload, a crash or a lost connection without asking the user to re-record.
 */
const DB_NAME = "clipthread";
const STORE = "segments";

export interface StoredSegment {
  key: string; // `${campaignId}:${promptId}`
  campaignId: string;
  promptId: string;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  savedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("campaignId", "campaignId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
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
  });
}

export const segmentKeyFor = (campaignId: string, promptId: string) => `${campaignId}:${promptId}`;

export async function saveSegment(s: Omit<StoredSegment, "key" | "savedAt">) {
  try {
    await tx("readwrite", (store) =>
      store.put({ ...s, key: segmentKeyFor(s.campaignId, s.promptId), savedAt: Date.now() }),
    );
  } catch (err) {
    // Private mode / quota exceeded: recording still works, just not resumable across reloads.
    console.warn("Could not persist segment", err);
  }
}

export async function loadSegments(campaignId: string): Promise<StoredSegment[]> {
  try {
    return await tx("readonly", (store) => store.index("campaignId").getAll(campaignId));
  } catch {
    return [];
  }
}

export async function clearSegments(campaignId: string) {
  const segs = await loadSegments(campaignId);
  await Promise.all(segs.map((s) => tx("readwrite", (store) => store.delete(s.key)).catch(() => undefined)));
}

/** Tracks a created-but-not-finalized submission so a reload can resume uploading. */
export interface PendingSubmission {
  videoId: string;
  campaignId: string;
  segments: { index: number; promptId: string; sizeBytes: number }[];
  createdAt: number;
}

const pendingKey = (campaignId: string) => `clipthread:pending:${campaignId}`;

export function savePending(p: PendingSubmission) {
  try {
    localStorage.setItem(pendingKey(p.campaignId), JSON.stringify(p));
  } catch {}
}

export function loadPending(campaignId: string): PendingSubmission | null {
  try {
    const raw = localStorage.getItem(pendingKey(campaignId));
    return raw ? (JSON.parse(raw) as PendingSubmission) : null;
  } catch {
    return null;
  }
}

export function clearPending(campaignId: string) {
  try {
    localStorage.removeItem(pendingKey(campaignId));
  } catch {}
}
