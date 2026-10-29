import { deepClone } from './util.js';
/* Large editable records live in IndexedDB; synchronous reads use a hydrated cache.
 * localStorage remains a fallback for file viewers without IndexedDB support.
 */
const records = new Map();
let db = null;
let queue = Promise.resolve();
const failures = new Map();
let initialization = null;

function transaction(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', mode);
    action(tx.objectStore('records'));
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('STORAGE_FAILED'));
  });
}

function enqueue(key, action) {
  queue = queue.then(action).then(() => { failures.delete(key); }, err => {
    failures.set(key, err);
    document.dispatchEvent(new CustomEvent('vnmy:storage-error', { detail: err }));
  });
}

export function initializeStorage() {
  if (initialization) return initialization;
  initialization = (async () => {
    if (!globalThis.indexedDB) return;
    try {
      db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('vnmy-library', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('STORAGE_BLOCKED'));
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('records');
        const request = tx.objectStore('records').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          records.set(cursor.key, cursor.value);
          cursor.continue();
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      // Remove each legacy record only AFTER its IndexedDB transaction commits.
      const legacy = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('vnmy:story:') || key === 'vnmy:universes') legacy.push(key);
        }
      } catch { /* localStorage may be unavailable while IndexedDB works */ }
      for (const key of legacy) {
        let value;
        try { value = JSON.parse(localStorage.getItem(key)); } catch { continue; }
        try {
          await transaction('readwrite', store => store.put(value, key));
          records.set(key, value);
          try { localStorage.removeItem(key); } catch { /* retain legacy backup */ }
        } catch (err) {
          // A failed migration must leave the old record readable and retryable.
          console.warn('[vnmy] keeping legacy record after migration failure', key, err);
        }
      }
      db.onversionchange = () => { db.close(); db = null; };
    } catch (err) {
      console.warn('[vnmy] IndexedDB unavailable; keeping existing browser storage', err);
      db?.close();
      db = null;
    }
  })();
  return initialization;
}

export function getLargeRecord(key, fallback) {
  return records.has(key) ? deepClone(records.get(key)) : fallback();
}

export function putLargeRecord(key, value, fallback) {
  if (!db) return fallback();
  const copy = deepClone(value);
  records.set(key, copy);
  enqueue(key, () => transaction('readwrite', store => store.put(copy, key)));
}

export function removeLargeRecord(key, fallback) {
  fallback();
  if (!db) return;
  records.delete(key);
  enqueue(key, () => transaction('readwrite', store => store.delete(key)));
}

export async function flushStorage() {
  await queue;
  if (failures.size) throw failures.values().next().value;
}

export function storageBackend() { return db ? 'IndexedDB' : 'localStorage'; }
export function largeStorageSize() {
  let used = 0;
  for (const value of records.values()) used += JSON.stringify(value).length;
  return used;
}

export function largeRecordKeys() { return [...records.keys()]; }
