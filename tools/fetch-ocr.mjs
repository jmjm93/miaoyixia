// Vendors everything the text recogniser needs into extension/data/ocr/.
//
// Run `npm run fetch-ocr`. Like the dictionary shards next door, none of this is checked into
// the repo -- it is several megabytes of third-party build output, and a fresh clone rebuilds it.
//
// It has to be vendored at all because MV3 forbids remote code: tesseract.js defaults to pulling
// its worker and its WASM core from a CDN, which an extension may not do. Model weights are data
// rather than code and would be allowed to download at runtime, but the fast Chinese model is
// only ~2.5 MB, so shipping it costs less than a download flow and a permission prompt would.
//
// Four files, and only four:
//
//   tesseract.esm.min.js         the library, imported by the offscreen document
//   worker.min.js                its worker thread              -> workerPath
//   tesseract-core-simd-lstm...  the OCR engine itself          -> corePath
//   chi_sim.traineddata          simplified Chinese, "fast"     -> langPath
//
// The core is pinned to one build rather than letting tesseract.js choose. Left to itself it
// feature-detects and composes a filename, which would mean vendoring all six variants for
// ~22 MB. Passing a corePath that ends in ".js" makes it use that file verbatim -- and SIMD has
// been in Chrome since 91, so the SIMD build is safe to assume. "lstm" is the neural engine
// only, without the legacy one we never ask for.

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'extension', 'data', 'ocr');

/** Copied straight out of node_modules, so the versions always match package-lock. */
const COPY = [
  ['tesseract.js/dist/tesseract.esm.min.js', 'tesseract.esm.min.js'],
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
];

// tessdata_fast, not tessdata: 2.5 MB against 44 MB for the same language. The full model is
// more accurate on clean scans, but it is not 18x more accurate on a speech bubble, and it would
// dominate the package.
//
// All four combinations of script and direction ship. Which one runs is a setting rather than
// something guessed at: simplified and traditional share a great many characters, so a wrong
// guess there produces a plausible, confidently wrong reading rather than obvious nonsense --
// see the note on the OCR settings in settings.js. Manhua is frequently set vertically in both
// scripts, so none of the four is optional.
const TESSDATA = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main';
const MODELS = ['chi_sim', 'chi_tra', 'chi_sim_vert', 'chi_tra_vert'];

const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;

await mkdir(outDir, { recursive: true });

let total = 0;
for (const [from, name] of COPY) {
  const source = join(root, 'node_modules', from);
  try {
    await copyFile(source, join(outDir, name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`${from} is missing -- run \`npm install\` first.`);
  }
  const { size } = await stat(join(outDir, name));
  total += size;
  console.log(`  ${name.padEnd(34)} ${mb(size).padStart(9)}`);
}

/**
 * Downloads are sequential, and retried.
 *
 * Fetching the four in parallel looks obviously better and is not: four concurrent connections
 * to raw.githubusercontent reliably tripped Node's 10s connect timeout here, failing the whole
 * run after the copies had already been written. One at a time takes a few seconds longer and
 * actually finishes.
 */
async function download(name, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${TESSDATA}/${name}`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Failed to download ${name}: ${error.message}`);
      console.log(`  ${name.padEnd(34)}    retrying (${error.message})`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

for (const model of MODELS) {
  const name = `${model}.traineddata`;
  const bytes = await download(name);
  // Uncompressed on purpose: the recogniser is created with `gzip: false`, so tesseract.js asks
  // for this exact name. The saving from shipping it gzipped is undone by the Web Store ZIP.
  await writeFile(join(outDir, name), bytes);
  total += bytes.length;
  console.log(`  ${name.padEnd(34)} ${mb(bytes.length).padStart(9)}`);
}

console.log(`\nWrote ${outDir}`);
console.log(`  ${mb(total)} total`);
