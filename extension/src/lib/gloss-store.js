// The Spanish gloss layer: downloaded on demand, then local forever.
//
// The definitions are not shipped in the extension package. CC-CEDICT's Spanish translation is
// ~10 MB, which would roughly double the download for every user in order to serve the few who
// want it -- and it does not scale past one extra language. So it is fetched once, from the
// repository that publishes it, when the user actually asks for Spanish.
//
// The whole file is fetched in one request, deliberately, rather than a shard at a time. Shard
// indices are derived from the head character of a word, so fetching shard 47 mid-hover would
// tell the host roughly which character the user just read. One upfront download leaks only
// "somebody enabled Spanish"; lazy fetching would leak a reading stream. That is the reason,
// and it is worth more than the bandwidth it costs.
//
// After the download the feature is fully offline. The only online moment in this extension's
// life is this one, it is user-initiated, and no hovered word ever leaves the machine.

import { SHARD_COUNT, shardFor } from './shard.js';

/**
 * Pinned to a tag, not a branch.
 *
 * A branch URL changes underneath you: two people installing the same extension version could
 * get different dictionaries, and a bad upstream commit would reach users who never updated
 * anything. A tag makes the gloss layer a versioned dependency like any other.
 */
export const GLOSS_SOURCES = {
  es: {
    url: 'https://raw.githubusercontent.com/jmjm93/cedict-translations/v0.9/languages/es/cedict_es.u8',
    version: 'v0.9',
  },
};

/** Host pattern the optional permission is requested for. Must match manifest.json. */
export const GLOSS_ORIGIN = 'https://raw.githubusercontent.com/';

const DB_NAME = 'zh-gloss';
const DB_VERSION = 1;
const SHARDS = 'shards';
const META = 'meta';

const MAX_CACHED_SHARDS = 24;
/** @type {Map<string, Record<string, string>>} insertion-ordered, used as an LRU */
const shardCache = new Map();

// --- IndexedDB, minimally promisified ------------------------------------------------------

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SHARDS)) db.createObjectStore(SHARDS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run one transaction and resolve with what `work` asked for.
 *
 * `work` may return an IDBRequest (a read) or nothing (a batch of writes), so the result is
 * unwrapped by *type*, not by truthiness. Testing `request.result` instead would be wrong in
 * exactly the case that matters: a miss sets `result` to `undefined`, and a `??` fallback then
 * hands back the IDBRequest itself -- an object, therefore truthy, therefore indistinguishable
 * from a stored record to every caller downstream.
 */
function run(store, mode, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = work(tx.objectStore(store));
        tx.oncomplete = () => {
          db.close();
          resolve(request instanceof IDBRequest ? request.result : request);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

// --- reading -------------------------------------------------------------------------------

/**
 * One shard of translated senses, keyed by entry identity.
 *
 * Same LRU shape as dict-store's, and for the same reason: an MV3 service worker is killed
 * and restarted constantly, so a lookup must stay cheap from cold. A shard is ~100 KB.
 */
export async function loadGlossShard(lang, index) {
  const key = `${lang}:${index}`;
  const cached = shardCache.get(key);
  if (cached) {
    shardCache.delete(key);
    shardCache.set(key, cached);
    return cached;
  }

  const shard = (await run(SHARDS, 'readonly', (s) => s.get(key))) ?? null;
  if (!shard) return null;

  shardCache.set(key, shard);
  while (shardCache.size > MAX_CACHED_SHARDS) {
    shardCache.delete(shardCache.keys().next().value);
  }
  return shard;
}

/**
 * Identity of a dictionary entry. Mirrors tools/build-dict.mjs.
 *
 * All three fields are load-bearing: `simplified + pinyin` alone is *not* unique in CC-CEDICT,
 * and keying on it maps one entry's glosses onto a different entry's senses.
 */
export function glossKey(traditional, simplified, pinyin) {
  return `${traditional || simplified}\t${simplified}\t${pinyin}`;
}

/**
 * Translated senses for one packed dictionary row, or null if this entry has none.
 *
 * A null is normal, not an error: the translation is a few hundred entries short of
 * CC-CEDICT, and CC-CEDICT gains entries between gloss releases. Callers fall back to English.
 *
 * @param {string} lang
 * @param {string} headword the form the user hovered -- selects the shard
 * @param {string[]} row packed entry: [simplified, traditional|'', pinyin, senses]
 */
export async function glossFor(lang, headword, row) {
  const shard = await loadGlossShard(lang, shardFor(headword));
  if (!shard) return null;
  const senses = shard[glossKey(row[1], row[0], row[2])];
  return senses ? senses.split('/') : null;
}

// --- downloading ---------------------------------------------------------------------------

// TRADITIONAL SIMPLIFIED [pin1 yin1] /sense/sense/
const LINE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/;

/**
 * Turn a CC-CEDICT-format file into per-shard maps.
 *
 * Bucketed by the same rule the English shards use, and stored under *both* the simplified and
 * traditional headwords, so a hover touches exactly one Spanish shard whichever script the
 * page is written in.
 */
export function shardGlosses(text) {
  const shards = Array.from({ length: SHARD_COUNT }, () => ({}));
  let entries = 0;

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = LINE.exec(line.trimEnd());
    if (!match) continue;
    const [, traditional, simplified, pinyin, senses] = match;
    if (!senses) continue;
    entries++;

    const key = glossKey(traditional, simplified, pinyin);
    for (const headword of new Set([simplified, traditional])) {
      shards[shardFor(headword)][key] = senses;
    }
  }
  return { shards, entries };
}

/** Whether the host permission for the gloss source has been granted. */
export function hasGlossPermission() {
  return chrome.permissions.contains({ origins: [`${GLOSS_ORIGIN}*`] });
}

/** Ask for it. Must be called from a user gesture, so this belongs to the options page. */
export function requestGlossPermission() {
  return chrome.permissions.request({ origins: [`${GLOSS_ORIGIN}*`] });
}

/**
 * Download, verify and store a gloss layer.
 *
 * `onProgress` receives bytes downloaded, or null once the download is done and the parse has
 * started -- the parse is the slow part on a cold machine and silence there reads as a hang.
 */
export async function downloadGlosses(lang, onProgress = () => {}) {
  const source = GLOSS_SOURCES[lang];
  if (!source) throw new Error(`No gloss source for "${lang}"`);

  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);

  // Streamed so the options page can show progress on a 10 MB file.
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received);
  }
  onProgress(null);

  const all = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(all);

  // A 200 from a raw-content host proves only that something came back -- a moved file yields
  // an HTML error page with a 200 in front of it. Refuse to store anything that isn't a
  // dictionary rather than silently filling IndexedDB with markup.
  const declared = Number(text.match(/^#! entries=(\d+)$/m)?.[1] ?? 0);
  const { shards, entries } = shardGlosses(text);
  if (!declared || !entries) throw new Error('Downloaded file is not a CC-CEDICT dictionary');
  if (entries !== declared) {
    throw new Error(`Truncated download: header declares ${declared} entries, parsed ${entries}`);
  }

  await run(SHARDS, 'readwrite', (store) => {
    for (const [i, shard] of shards.entries()) store.put(shard, `${lang}:${i}`);
  });
  await run(META, 'readwrite', (store) =>
    store.put(
      {
        entries,
        version: source.version,
        url: source.url,
        derivedFrom: text.match(/^#! derived-from=(.*)$/m)?.[1] ?? 'unknown',
        downloadedAt: new Date().toISOString(),
      },
      lang,
    ),
  );

  for (const key of [...shardCache.keys()]) {
    if (key.startsWith(`${lang}:`)) shardCache.delete(key);
  }
  readyCache.delete(lang);
  return { entries, bytes: received };
}

/** What we know about a stored gloss layer, or null if it hasn't been downloaded. */
export function glossInfo(lang) {
  return run(META, 'readonly', (store) => store.get(lang)).then((info) => info ?? null);
}

/**
 * Memoised because this is consulted on the hover path.
 *
 * Without it every lookup opens an IndexedDB transaction just to re-learn something that
 * changes about twice in an install's lifetime. The service worker resets it when the options
 * page reports a download or a removal -- see resetGlossReady().
 *
 * @type {Map<string, boolean>}
 */
const readyCache = new Map();

/** Whether a downloaded layer is present *and* matches the version this build expects. */
export async function glossReady(lang) {
  if (readyCache.has(lang)) return readyCache.get(lang);
  const info = await glossInfo(lang);
  // A version mismatch means the extension updated to expect a newer gloss release than the
  // one on disk. Treated as not-ready rather than used anyway: an older layer keyed against an
  // older CC-CEDICT would quietly mistranslate entries that shifted.
  const ready = Boolean(info && info.version === GLOSS_SOURCES[lang]?.version);
  readyCache.set(lang, ready);
  return ready;
}

/** Forget the memoised answer, after a download or a removal. */
export function resetGlossReady() {
  readyCache.clear();
}

/** Remove a downloaded layer, freeing its ~13 MB. */
export async function clearGlosses(lang) {
  await run(SHARDS, 'readwrite', (store) => {
    for (let i = 0; i < SHARD_COUNT; i++) store.delete(`${lang}:${i}`);
  });
  await run(META, 'readwrite', (store) => store.delete(lang));
  for (const key of [...shardCache.keys()]) {
    if (key.startsWith(`${lang}:`)) shardCache.delete(key);
  }
  readyCache.delete(lang);
}
