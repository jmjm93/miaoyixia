// Japanese is an optional data pack. Importing this module never opens a database or fetches.
// Downloads run in the options page; lookups and OCR only read local IndexedDB records.
import { dictionaryFromArchive } from './archive.js';
import { buildJapaneseDictionary, japaneseMatches } from './japanese.js';

const RELEASE = '3.6.2+20261005200550';
export const JAPANESE_VERSION = `jmdict-${RELEASE}-tessdata-4.1.0-v1`;
export const JAPANESE_ORIGINS = [
  'https://github.com/*',
  'https://release-assets.githubusercontent.com/*',
  'https://raw.githubusercontent.com/*',
];
export const JAPANESE_SOURCES = {
  dictionary: `https://github.com/scriptin/jmdict-simplified/releases/download/${RELEASE}/jmdict-eng-${RELEASE}.json.tgz`,
  jpn: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/jpn.traineddata',
  jpn_vert: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/jpn_vert.traineddata',
};

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zh-japanese', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(mode, work) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('assets', mode);
    let result;
    try { result = work(tx.objectStore('assets')); } catch (error) { tx.abort(); db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(result instanceof IDBRequest ? result.result : result); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Japanese storage transaction aborted')); };
  });
}

export const japaneseInfo = () => transaction('readonly', (store) => store.get('meta')).then((info) => info ?? null);
export const japaneseReady = async () => (await japaneseInfo())?.version === JAPANESE_VERSION;
export async function japaneseModel(model) {
  if (!['jpn', 'jpn_vert'].includes(model) || !(await japaneseReady())) throw new Error('Japanese has not been downloaded');
  const data = await transaction('readonly', (store) => store.get(model));
  if (!(data instanceof Uint8Array)) throw new Error('Japanese OCR model is missing; download Japanese again');
  return data;
}

const shards = new Map();
export function resetJapaneseCache() { shards.clear(); }
async function loadShard(index) {
  if (shards.has(index)) {
    const value = shards.get(index);
    shards.delete(index); shards.set(index, value);
    return value;
  }
  const pending = transaction('readonly', (store) => store.get(`shard:${index}`)).catch((error) => {
    shards.delete(index); throw error;
  });
  shards.set(index, pending);
  while (shards.size > 24) shards.delete(shards.keys().next().value);
  return pending;
}

export async function lookupJapanese(text) {
  const meta = await japaneseInfo();
  if (meta?.version !== JAPANESE_VERSION) throw new Error('Japanese has not been downloaded; enable it in Options');
  return japaneseMatches(text, loadShard, meta.maxWordLength);
}

export async function japaneseMatchesByPosition(text) {
  const meta = await japaneseInfo();
  if (meta?.version !== JAPANESE_VERSION) throw new Error('Japanese has not been downloaded; enable it in Options');
  const chars = [...text];
  // Sequential to bound IDB work on a long OCR line; each shard is memoised.
  const matches = [];
  for (let start = 0; start < chars.length; start++) {
    matches.push(await japaneseMatches(chars.slice(start, start + meta.maxWordLength + 12).join(''), loadShard, meta.maxWordLength));
  }
  return matches;
}

async function download(url, progress) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Japanese download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 40_000_000) { await reader.cancel(); throw new Error('Japanese download is unexpectedly large'); }
    chunks.push(value); progress(value.length);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function validateJapaneseModel(data) {
  // traineddata starts with an int32 component count followed by int64 offsets.
  if (data.length < 100_000) throw new Error('Invalid Japanese OCR model');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getInt32(0, true);
  if (count < 20 || count > 100) throw new Error('Invalid Japanese OCR model header');
  for (let i = 0; i < count; i++) {
    const offset = view.getBigInt64(4 + i * 8, true);
    if (offset !== -1n && (offset < BigInt(4 + count * 8) || offset >= BigInt(data.length))) {
      throw new Error('Truncated Japanese OCR model');
    }
  }
}

/** Commit everything together: partial downloads can never become a ready pack. */
export async function downloadJapanese(onProgress = () => {}) {
  if (!(await chrome.permissions.contains({ origins: JAPANESE_ORIGINS }))) throw new Error('Japanese download needs network permission');
  let received = 0;
  const progress = (bytes) => { received += bytes; onProgress(received); };
  const archive = await download(JAPANESE_SOURCES.dictionary, progress);
  onProgress(null);
  const dictionary = await dictionaryFromArchive(archive);
  const built = buildJapaneseDictionary(dictionary);
  const models = {};
  for (const model of ['jpn', 'jpn_vert']) {
    models[model] = await download(JAPANESE_SOURCES[model], progress);
    validateJapaneseModel(models[model]);
  }
  onProgress(null);
  const meta = { ...built.meta, version: JAPANESE_VERSION, bytes: received, downloadedAt: new Date().toISOString() };
  await transaction('readwrite', (store) => {
    store.clear();
    built.shards.forEach((shard, index) => store.put(shard, `shard:${index}`));
    for (const [model, data] of Object.entries(models)) store.put(data, model);
    store.put(meta, 'meta');
  });
  resetJapaneseCache();
  return meta;
}

export async function clearJapanese() {
  await transaction('readwrite', (store) => store.clear());
  resetJapaneseCache();
  // Also remove temporary engine-cache copies left by an interrupted initialization.
  const db = await modelCacheDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keyval', 'readwrite');
      for (const model of ['jpn', 'jpn_vert']) tx.objectStore('keyval').delete(`./${model}.traineddata`);
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

function modelCacheDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('keyval-store', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keyval');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Tesseract's browser cache is idb-keyval's default store (tesseract.js v7).
 * Seed it from our local pack, then delete the temporary copy after initialization.
 * The fallback langPath still points inside the extension: OCR cannot fetch remote models.
 */
export async function withJapaneseModelCache(model, start) {
  const data = await japaneseModel(model);
  const db = await modelCacheDatabase();
  const key = `./${model}.traineddata`;
  const write = (remove) => new Promise((resolve, reject) => {
    const tx = db.transaction('keyval', 'readwrite');
    if (remove) tx.objectStore('keyval').delete(key);
    else tx.objectStore('keyval').put(data, key);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  try { await write(false); return await start(); }
  finally { try { await write(true); } finally { db.close(); } }
}
