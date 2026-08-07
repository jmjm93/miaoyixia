// Compiles vendor/cedict_ts.u8 into the sharded lookup tables the extension ships.
//
// The bucketing rule itself lives in extension/src/lib/shard.js, shared with the runtime so
// the two cannot drift. See there for why the dictionary is sharded at all.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SHARD_COUNT, shardFor } from '../extension/src/lib/shard.js';

export { SHARD_COUNT, shardFor };

// TRADITIONAL SIMPLIFIED [pin1 yin1] /sense one/sense two/
const LINE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/;

export function parseLine(line) {
  if (!line || line.startsWith('#')) return null;
  const match = LINE.exec(line);
  if (!match) return null;
  const [, traditional, simplified, pinyin, senses] = match;
  const defs = senses.split('/').filter(Boolean);
  if (!defs.length) return null;
  return { traditional, simplified, pinyin, defs };
}

function build(text) {
  const shards = Array.from({ length: SHARD_COUNT }, () => ({}));
  const stats = { entries: 0, skipped: 0, maxWordLength: 0, headwords: 0 };

  for (const line of text.split('\n')) {
    const entry = parseLine(line.trimEnd());
    if (!line || line.startsWith('#')) continue;
    if (!entry) {
      stats.skipped++;
      continue;
    }
    stats.entries++;

    const { traditional, simplified, pinyin, defs } = entry;
    // [simplified, traditional-if-different, numbered pinyin, senses joined by "/"].
    // Pinyin stays in CC-CEDICT's numbered form -- the runtime renders tone marks and
    // still has the tone digits available for study-card output.
    const packed = [simplified, traditional === simplified ? '' : traditional, pinyin, defs.join('/')];

    // Both scripts are lookup keys so the extension works on mainland and Taiwanese pages.
    for (const headword of new Set([simplified, traditional])) {
      const bucket = shards[shardFor(headword)];
      (bucket[headword] ??= []).push(packed);
      stats.maxWordLength = Math.max(stats.maxWordLength, [...headword].length);
    }
  }

  for (const bucket of shards) stats.headwords += Object.keys(bucket).length;
  return { shards, stats };
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = join(root, 'vendor', 'cedict_ts.u8');
  const outDir = join(root, 'extension', 'data');
  const shardDir = join(outDir, 'shards');

  let text;
  try {
    text = await readFile(source, 'utf8');
  } catch {
    console.error(`Missing ${source} -- run \`npm run fetch-dict\` first.`);
    process.exit(1);
  }

  const started = process.hrtime.bigint();
  const { shards, stats } = build(text);

  await rm(shardDir, { recursive: true, force: true });
  await mkdir(shardDir, { recursive: true });

  let bytes = 0;
  let largest = 0;
  await Promise.all(
    shards.map(async (bucket, i) => {
      const json = JSON.stringify(bucket);
      bytes += json.length;
      largest = Math.max(largest, json.length);
      await writeFile(join(shardDir, `${i}.json`), json, 'utf8');
    }),
  );

  const meta = {
    source: 'CC-CEDICT (https://cc-cedict.org/) - CC BY-SA 4.0',
    release: text.match(/^#! date=(.*)$/m)?.[1] ?? 'unknown',
    builtFrom: 'cedict_ts.u8',
    shardCount: SHARD_COUNT,
    entries: stats.entries,
    headwords: stats.headwords,
    maxWordLength: stats.maxWordLength,
  };
  await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`Built ${SHARD_COUNT} shards in ${ms.toFixed(0)} ms`);
  console.log(`  entries:        ${stats.entries.toLocaleString()} (${stats.skipped} unparsed)`);
  console.log(`  headwords:      ${stats.headwords.toLocaleString()} (both scripts)`);
  console.log(`  longest word:   ${stats.maxWordLength} chars`);
  console.log(`  total size:     ${(bytes / 1e6).toFixed(2)} MB`);
  console.log(`  largest shard:  ${(largest / 1e3).toFixed(0)} KB`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
