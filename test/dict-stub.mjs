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

/** Convenience for tests that just want render-ready candidates for a string. */
export async function candidatesFor(text, context = {}) {
  const { lookupCandidates } = await import('../extension/src/lib/dict-store.js');
  const { buildCard } = await import('../extension/src/lib/card.js');

  const matches = await lookupCandidates(text);
  return matches.map(({ headword, length, entries }) => ({
    headword,
    length,
    cards: entries.map((row) => buildCard(headword, row, context)),
  }));
}
