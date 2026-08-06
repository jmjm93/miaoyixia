// Dictionary access for the service worker.
//
// Shards are fetched on demand and memoised. Because every candidate for a hover
// starts with the same character, a lookup touches exactly one shard -- so even a
// cold service worker answers after parsing ~130 KB instead of the whole 16 MB.

const SHARD_COUNT = 128; // must match tools/build-dict.mjs
const MAX_CACHED_SHARDS = 24;

/** @type {Map<number, Record<string, string[][]>>} insertion-ordered, used as an LRU */
const shardCache = new Map();
/** @type {Promise<object>|null} */
let metaPromise = null;

/** Which shard holds words beginning with `char`. Mirrors tools/build-dict.mjs. */
function shardFor(char) {
  return char.codePointAt(0) % SHARD_COUNT;
}

export function loadMeta() {
  // Clear a rejected promise so a transient failure doesn't poison every later lookup.
  metaPromise ??= fetch(chrome.runtime.getURL('data/meta.json'))
    .then((r) => r.json())
    .catch((error) => {
      metaPromise = null;
      throw error;
    });
  return metaPromise;
}

async function loadShard(index) {
  const cached = shardCache.get(index);
  if (cached) {
    // Refresh recency.
    shardCache.delete(index);
    shardCache.set(index, cached);
    return cached;
  }

  const response = await fetch(chrome.runtime.getURL(`data/shards/${index}.json`));
  if (!response.ok) throw new Error(`Missing dictionary shard ${index}`);
  const shard = await response.json();

  shardCache.set(index, shard);
  while (shardCache.size > MAX_CACHED_SHARDS) {
    shardCache.delete(shardCache.keys().next().value);
  }
  return shard;
}

/**
 * All dictionary matches that start at the beginning of `text`, longest first.
 *
 * `text` is the run of characters the content script read forward from the cursor.
 * We try every prefix and keep the ones the dictionary knows, which is the standard
 * longest-match-from-cursor behaviour -- except we return *all* lengths rather than
 * just the winner, so the popup can offer one tab per candidate.
 *
 * @param {string} text
 * @returns {Promise<Array<{headword: string, length: number, entries: string[][]}>>}
 */
export async function lookupCandidates(text) {
  const chars = [...text];
  if (!chars.length) return [];

  const { maxWordLength = 8 } = await loadMeta();
  const shard = await loadShard(shardFor(chars[0]));

  const matches = [];
  const limit = Math.min(chars.length, maxWordLength);
  for (let length = limit; length >= 1; length--) {
    const headword = chars.slice(0, length).join('');
    const entries = shard[headword];
    if (entries) matches.push({ headword, length, entries });
  }
  return matches;
}
