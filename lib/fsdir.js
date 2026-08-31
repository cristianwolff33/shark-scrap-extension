/**
 * @file Minimalny wrapper na File System Access API — wybór folderu wyjściowego RAZ (przy
 * pierwszym eksporcie w prostym trybie, patrz sidepanel/main.js), persystowany w IndexedDB
 * między sesjami (jeśli przeglądarka nadal ma ważne uprawnienie), żeby nie pytać przy każdym
 * eksporcie/zdjęciu z osobna. To NIE jest kod nietestowalny z lenistwa — indexedDB i
 * showDirectoryPicker to realne API przeglądarki, których nie da się sensownie zasymulować w
 * Node bez ciężkich zależności (ten sam kompromis co microdata.js/dom-heuristics.js — patrz
 * ich komentarze; weryfikacja e2e, nie jednostkowa).
 */

const DB_NAME = "scraper-client-fs";
const STORE = "handles";
const KEY = "output-dir";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function isSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/** Próbuje po cichu odzyskać wcześniej wybrany folder — bez pytania, tylko jeśli uprawnienie wciąż ważne. */
export async function restoreOutputDir() {
  if (!isSupported()) return null;
  try {
    const handle = await idbGet(KEY);
    if (!handle) return null;
    const perm = await handle.queryPermission({ mode: "readwrite" });
    return perm === "granted" ? handle : null;
  } catch {
    return null; // IndexedDB niedostępny (np. tryb prywatny) albo handle już nieważny
  }
}

/** Prosi usera o wybór folderu — MUSI być wołane bezpośrednio z handlera kliknięcia (gest usera). */
export async function pickOutputDir() {
  const handle = await window.showDirectoryPicker({ id: "scraper-client-outputs", mode: "readwrite" });
  try {
    await idbSet(KEY, handle);
  } catch {
    // nie blokujemy eksportu, jeśli zapis do IndexedDB się nie uda — po prostu user wybierze ponownie następnym razem
  }
  return handle;
}

/** Podfolder (np. domeny sklepu) wewnątrz wybranego katalogu — tworzy, jeśli nie istnieje. */
export async function subdir(rootHandle, name) {
  return rootHandle.getDirectoryHandle(name, { create: true });
}

/** Zapisuje Blob jako plik w danym katalogu (nadpisuje, jeśli już istnieje). */
export async function writeFile(dirHandle, filename, blob) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}
