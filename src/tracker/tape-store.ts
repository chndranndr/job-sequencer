export type TapeTrackMeta = {
  id: string;
  name: string;
  addedAt: string;
  duration: number;
};

type StoredTrack = TapeTrackMeta & { blob: Blob };

const DB_NAME = "greenfield-tracker-tape";
const DB_VERSION = 1;
const STORE = "tracks";

export function sanitizeTrackName(name: string) {
  const base = name.trim().replace(/\.(mp3|mpeg)$/i, "").trim();
  return base || "Untitled track";
}

export function formatTapeTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open tape library."));
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const request = run(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Tape library request failed."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error ?? new Error("Tape library transaction failed."));
  }));
}

export async function listTapeTracks(): Promise<TapeTrackMeta[]> {
  const rows = await withStore<StoredTrack[]>("readonly", (store) => store.getAll());
  return rows
    .map(({ id, name, addedAt, duration }) => ({ id, name, addedAt, duration }))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

export async function getTapeTrackBlob(id: string): Promise<Blob> {
  const row = await withStore<StoredTrack | undefined>("readonly", (store) => store.get(id));
  if (!row?.blob) throw new Error("Track not found on tape.");
  return row.blob;
}

async function probeDuration(blob: Blob): Promise<number> {
  if (typeof Audio === "undefined") return 0;
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve) => {
      const audio = new Audio();
      audio.preload = "metadata";
      audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => resolve(0);
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function addTapeTrack(file: File): Promise<TapeTrackMeta> {
  const type = file.type.toLowerCase();
  if (!/\.mp3$/i.test(file.name) && type !== "audio/mpeg" && type !== "audio/mp3") {
    throw new Error("Only MP3 files can be loaded onto tape.");
  }
  const blob = file.slice(0, file.size, file.type || "audio/mpeg");
  const duration = await probeDuration(blob);
  const track: StoredTrack = {
    id: globalThis.crypto?.randomUUID?.() ?? `tape-${Date.now()}`,
    name: sanitizeTrackName(file.name),
    addedAt: new Date().toISOString(),
    duration,
    blob,
  };
  await withStore("readwrite", (store) => store.put(track));
  return { id: track.id, name: track.name, addedAt: track.addedAt, duration: track.duration };
}

export async function removeTapeTrack(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}
