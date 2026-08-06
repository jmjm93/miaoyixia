// Downloads the latest CC-CEDICT release and unpacks it to vendor/cedict_ts.u8.
//
// CC-CEDICT is published by MDBG under CC BY-SA 4.0. The raw file is not checked
// into the repo; run `npm run fetch-dict` to (re)populate vendor/.

import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'vendor');
const target = join(vendorDir, 'cedict_ts.u8');

const response = await fetch(SOURCE);
if (!response.ok) {
  throw new Error(`Failed to download CC-CEDICT: ${response.status} ${response.statusText}`);
}

const gz = Buffer.from(await response.arrayBuffer());
const text = gunzipSync(gz).toString('utf8');

await mkdir(vendorDir, { recursive: true });
await writeFile(target, text, 'utf8');

const version = text.match(/^#! date=(.*)$/m)?.[1] ?? 'unknown';
console.log(`Wrote ${target}`);
console.log(`  ${(gz.length / 1e6).toFixed(2)} MB gzipped -> ${(text.length / 1e6).toFixed(2)} MB`);
console.log(`  CC-CEDICT release date: ${version}`);
