// IndexedDB store for session recordings. Lives at the extension origin, so the
// offscreen document (which has the Blob) writes here and the options page reads
// it. Metadata and blobs are kept in separate stores so listing is cheap.
const DB_NAME = 'pf-recordings';
const VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta'))  db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs'); // key = id
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function txDone(t) {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror    = () => rej(t.error);
    t.onabort    = () => rej(t.error);
  });
}

function reqResult(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

export async function addRecording(meta, blob) {
  const db = await openDB();
  const t = db.transaction(['meta', 'blobs'], 'readwrite');
  t.objectStore('meta').put(meta);
  t.objectStore('blobs').put(blob, meta.id);
  await txDone(t);
  db.close();
}

// Returns metadata only (no blobs), newest first.
export async function listMeta() {
  const db = await openDB();
  const t = db.transaction('meta', 'readonly');
  const all = await reqResult(t.objectStore('meta').getAll());
  db.close();
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getBlob(id) {
  const db = await openDB();
  const t = db.transaction('blobs', 'readonly');
  const blob = await reqResult(t.objectStore('blobs').get(id));
  db.close();
  return blob;
}

export async function deleteRecording(id) {
  const db = await openDB();
  const t = db.transaction(['meta', 'blobs'], 'readwrite');
  t.objectStore('meta').delete(id);
  t.objectStore('blobs').delete(id);
  await txDone(t);
  db.close();
}
