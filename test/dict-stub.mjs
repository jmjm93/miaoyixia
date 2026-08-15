// Lets the extension's dictionary modules run under Node by standing in for the two
// browser APIs they touch: chrome.runtime.getURL and fetch. Everything else in
// dict-store.js / card.js / pinyin.js is the real shipping code.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const PREFIX = 'stub:';

export function installDictStub() {
  globalThis.chrome ??= {};
  globalThis.chrome.runtime ??= { getURL: (path) => PREFIX + path };

  // Delegate anything that isn't ours, so puppeteer's own networking still works.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(PREFIX)) return realFetch(url, init);
    try {
      const body = await readFile(join(extensionDir, href.slice(PREFIX.length)), 'utf8');
      return { ok: true, json: async () => JSON.parse(body) };
    } catch {
      return { ok: false, json: async () => null };
    }
  };
}

/**
 * Convenience for tests that just want render-ready candidates for a string.
 *
 * `translate` stands in for the downloadable gloss layer: given an entry's English senses it
 * returns replacements, or null for an entry the layer doesn't cover. That null is the case
 * worth exercising -- it is how a real partly-translated dictionary behaves.
 */
/**
 * The same, for a whole recognised line: segmented into words, each with every candidate at its
 * starting position.
 *
 * Uses the real segment() and the real shards, so a test that reads a sentence exercises the
 * actual splitting rather than a fixture's idea of it.
 */
export async function readingFor(text, context = {}, translate = null) {
  const { matchesByPosition } = await import('../extension/src/lib/dict-store.js');
  const { buildCard } = await import('../extension/src/lib/card.js');
  const { segment } = await import('../extension/src/lib/segment.js');

  const chars = [...text];
  const matchesAt = await matchesByPosition(text);
  const spans = segment(
    chars.length,
    matchesAt.map((matches) => matches.map((match) => match.length)),
  );

  return spans.map(({ start, length }) => ({
    text: chars.slice(start, start + length).join(''),
    start,
    length,
    candidates: (matchesAt[start] ?? []).map(({ headword, length: wordLength, entries }) => ({
      headword,
      length: wordLength,
      cards: entries.map((row) => buildCard(headword, row, context, translate?.(row[3].split('/')) ?? null)),
    })),
  }));
}

export async function candidatesFor(text, context = {}, translate = null) {
  const { lookupCandidates } = await import('../extension/src/lib/dict-store.js');
  const { buildCard } = await import('../extension/src/lib/card.js');

  const matches = await lookupCandidates(text);
  return matches.map(({ headword, length, entries }) => ({
    headword,
    length,
    cards: entries.map((row) => buildCard(headword, row, context, translate?.(row[3].split('/')) ?? null)),
  }));
}
