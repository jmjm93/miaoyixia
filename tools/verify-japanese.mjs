// Explicit developer check only. Downloads into gitignored vendor/, never extension/.
// node tools/verify-japanese.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JAPANESE_SOURCES, validateJapaneseModel } from '../extension/src/lib/japanese-store.js';
import { dictionaryFromArchive } from '../extension/src/lib/archive.js';
import { buildJapaneseDictionary, japaneseMatches } from '../extension/src/lib/japanese.js';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('../vendor/japanese/', import.meta.url));
await mkdir(dir, { recursive: true });
for (const [name, url] of Object.entries(JAPANESE_SOURCES)) {
  const path = join(dir, name === 'dictionary' ? 'dictionary.tgz' : `${name}.traineddata`);
  let bytes;
  try { bytes = await readFile(path); }
  catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path, bytes);
  }
  if (name !== 'dictionary') validateJapaneseModel(bytes);
  console.log(`${name}: ${(bytes.length / 1e6).toFixed(2)} MB`);
}
const built = buildJapaneseDictionary(await dictionaryFromArchive(await readFile(join(dir, 'dictionary.tgz'))));
console.log(built.meta);
for (const text of ['食べました', '読んでいる', '高かった', '学校', 'ありがとう', 'コーヒー']) {
  const matches = await japaneseMatches(text, async (index) => built.shards[index], built.meta.maxWordLength);
  console.log(text, matches[0]?.entries.slice(0, 2));
}
