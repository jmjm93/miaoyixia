// Measures the recogniser against real captures.
//
//   npm run bench-ocr            every fixture
//   npm run bench-ocr -- <name>  just one
//
// Not a test. There is no threshold to pass: OCR accuracy on hand-lettered manhua is a number to
// push down, and what this exists for is to tell whether a change actually pushed it. Fixtures
// live in test/fixtures/ocr/ with their real text in expected.json.
//
// It runs focused sweeps, one variable at a time from the best configuration found so far. The
// full cross product is hundreds of runs and most of it is uninteresting.
//
// The sweeps are ordered by what the evidence has actually pointed at. On the first real fixture
// segmentation turned out to be fine -- ten cells found, in the right places, six read correctly
// -- and the failures were the recogniser misreading hand-lettered glyphs. That rules out every
// preprocessing trick and makes model quality the interesting axis, so it gets its own sweep.
//
// Every image operation happens in a real browser canvas, the same one the extension crops with.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createWorker } from 'tesseract.js';
import { INK_BELOW, findColumnCuts, recogniserScale } from '../extension/src/lib/ocr.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(root, 'test', 'fixtures', 'ocr');
const langPath = join(root, 'extension', 'data', 'ocr');

const CANDIDATE_BROWSERS = [
  process.env.ZH_DIC_BROWSER,
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/**
 * Fold differences that are not recognition mistakes.
 *
 * NFKC maps fullwidth forms onto their ASCII equivalents, so Tesseract answering "!" where the
 * truth says "！" stops counting as an error. Left in, it added a phantom 0.1 to every row of
 * every sweep -- enough to reorder them and to make a perfect read look imperfect.
 */
const normalise = (text) => (text ?? '').normalize('NFKC');

/** Character error rate: edits per character of the truth. 0 is perfect, 1 is hopeless. */
function cer(rawGot, rawWant) {
  const a = [...normalise(rawGot)];
  const b = [...normalise(rawWant)];
  if (!b.length) return a.length ? 1 : 0;

  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const rowCosts = [j];
    for (let i = 1; i <= a.length; i++) {
      rowCosts[i] = Math.min(
        prev[i] + 1,
        rowCosts[i - 1] + 1,
        prev[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = rowCosts;
  }
  return prev[a.length] / b.length;
}

// --- image operations, in a real canvas -------------------------------------

/**
 * @param {import('puppeteer-core').Page} page
 * @param {string} src data URL
 * @param {{scale?: number, rotate?: number, threshold?: boolean, slice?: [number, number]}} ops
 *   `slice` takes a fraction of the width, [from, to], for pulling one column out, and
 *   `sliceY` the same of the height -- the two together cut a single glyph out of a grid.
 *   `invert` flips light-on-dark to dark-on-light, which is what Tesseract expects.
 */
function transform(page, src, ops) {
  return page.evaluate(
    async ([src, ops]) => {
      const img = new Image();
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = fail;
        img.src = src;
      });

      const [from, to] = ops.slice ?? [0, 1];
      const sx = Math.round(img.width * from);
      const sw = Math.max(1, Math.round(img.width * (to - from)));
      const [fromY, toY] = ops.sliceY ?? [0, 1];
      const sy = Math.round(img.height * fromY);
      const sh = Math.max(1, Math.round(img.height * (toY - fromY)));
      const scale = ops.scale ?? 1;
      const angle = ((ops.rotate ?? 0) * Math.PI) / 180;
      // Whitespace around the glyph. A cell cut exactly on its grid lines has none, and
      // Tesseract's single-character mode wants a margin to find an edge against.
      const pad = ops.pad ?? 0;

      // Rotating needs a bigger canvas or the corners are cut off.
      const w = sw * scale;
      const h = sh * scale;
      const cw = Math.ceil(Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle)) + 2 * pad * w);
      const ch = Math.ceil(Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle)) + 2 * pad * h);

      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // White, not transparent: a transparent margin flattens to black, and a black frame around
      // the text is its own segmentation problem.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);

      ctx.translate(cw / 2, ch / 2);
      if (angle) ctx.rotate(angle);
      ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // Polarity first, then binarising. Tesseract assumes dark text on a light page, and light
      // text on a dark one tends to return nothing at all rather than something wrong -- its
      // layout analysis finds no regions to hand the recogniser.
      if (ops.invert) {
        const pixels = ctx.getImageData(0, 0, cw, ch);
        const d = pixels.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = 255 - d[i];
          d[i + 1] = 255 - d[i + 1];
          d[i + 2] = 255 - d[i + 2];
        }
        ctx.putImageData(pixels, 0, 0);
      }

      if (ops.threshold) {
        // Otsu: the classic between-class variance threshold. Tesseract binarises too, but it
        // does it over the whole image, and a screentone behind the lettering skews that.
        const pixels = ctx.getImageData(0, 0, cw, ch);
        const d = pixels.data;
        const histogram = new Array(256).fill(0);
        const grey = new Uint8Array(d.length / 4);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          grey[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
          histogram[grey[p]]++;
        }
        const total = grey.length;
        let sum = 0;
        for (let i = 0; i < 256; i++) sum += i * histogram[i];
        let sumB = 0;
        let wB = 0;
        let best = 0;
        let cut = 127;
        for (let i = 0; i < 256; i++) {
          wB += histogram[i];
          if (!wB) continue;
          const wF = total - wB;
          if (!wF) break;
          sumB += i * histogram[i];
          const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
          if (between > best) {
            best = between;
            cut = i;
          }
        }
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          const v = grey[p] > cut ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
      }

      return canvas.toDataURL('image/png');
    },
    [src, ops],
  );
}

// --- engines -----------------------------------------------------------------

const workers = new Map();

/** The core the extension ships. Measuring against any other one measures an engine nobody runs. */
const SHIPPED_CORE = join(langPath, 'tesseract-core-simd-lstm.wasm.js');

/**
 * The full SIMD core, from node_modules and never shipped.
 *
 * tessdata_best carries *float* LSTM weights, and the LSTM-only build we ship has no float
 * dot-product intrinsic -- it aborts the entire process with "missing function: DotProductSSE"
 * rather than failing the one call. So testing whether the best models are worth their 13 MB
 * also means finding out whether they cost a bigger core.
 */
const FULL_CORE = join(root, 'node_modules', 'tesseract.js-core', 'tesseract-core-simd.wasm.js');

async function workerFor(model, psm, dir = langPath, dpi = 0, core = SHIPPED_CORE) {
  const key = `${dir}|${model}|${psm}|${dpi}|${core}`;
  if (!workers.has(key)) {
    const worker = await createWorker(model, 1, {
      langPath: dir,
      corePath: core,
      gzip: false,
      cacheMethod: 'none',
    });
    const params = { tessedit_pageseg_mode: String(psm) };
    // Tesseract guesses resolution from the image, and on a small tight crop it guesses wildly --
    // it reported 721 dpi for a 113px-wide capture. That estimate drives its internal rescaling,
    // so it is worth pinning rather than leaving to a guess about a guess.
    if (dpi) params.user_defined_dpi = String(dpi);
    await worker.setParameters(params);
    workers.set(key, worker);
  }
  return workers.get(key);
}

/**
 * Fetch a model from a different tessdata repo, for comparison only.
 *
 * Lands in gitignored vendor/, never in extension/: nothing here ships unless a sweep shows it
 * is worth the megabytes.
 */
async function altModel(repo, model) {
  const dir = join(root, 'vendor', 'ocr-bench', repo);
  if (existsSync(join(dir, `${model}.traineddata`))) return dir;

  await mkdir(dir, { recursive: true });
  process.stdout.write(`   fetching ${repo}/${model}... `);
  const response = await fetch(`https://github.com/tesseract-ocr/${repo}/raw/main/${model}.traineddata`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(join(dir, `${model}.traineddata`), bytes);
  console.log(`${(bytes.length / 1e6).toFixed(2)} MB`);
  return dir;
}

const clean = (text) => (text ?? '').replace(/\s+/gu, '');

async function read(page, src, { model, psm, columns = 1, dir, dpi, core, slices: given, ...ops }) {
  // Vertical Chinese reads right column first, so slices are taken right to left.
  const slices =
    given ??
    Array.from({ length: columns }, (_, i) => [(columns - 1 - i) / columns, (columns - i) / columns]);

  let text = '';
  let confidence = 0;
  for (const slice of slices) {
    const url = await transform(page, src, {
      ...ops,
      slice: slices.length > 1 ? slice : ops.slice,
    });
    const worker = await workerFor(model, psm, dir, dpi, core);
    const { data } = await worker.recognize(url);
    text += clean(data.text);
    confidence += data.confidence / slices.length;
  }
  return { text, confidence };
}

/**
 * Ink per column of pixels, measured in the page.
 *
 * The loop mirrors inkProfile's, because the pixels live in the browser and shipping a megabyte
 * of them back per fixture is not worth it. The threshold and every decision taken from the
 * profile are imported, so the two cannot disagree about anything that matters.
 */
const profileOf = (page, src) =>
  page.evaluate(
    async ([src, inkBelow]) => {
      const img = new Image();
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = fail;
        img.src = src;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const profile = new Array(canvas.width).fill(0);
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if ((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 < inkBelow) profile[x]++;
        }
      }
      return { profile, width: canvas.width, height: canvas.height };
    },
    [src, INK_BELOW],
  );

/**
 * What the extension will actually do with this capture: the real scale rule *and* the real
 * column splitting, both imported rather than reimplemented.
 *
 * Worth the trouble. This row previously showed only the scale, so it under-reported what a user
 * gets -- the same quiet dishonesty as a fixture that ends up measuring itself.
 */
async function shippedRun(page, src, base, vertical) {
  const { profile, width, height } = await profileOf(page, src);
  const scale = recogniserScale(width, height);
  const cuts = vertical ? findColumnCuts(profile, height) : [];

  if (!cuts.length) return { label: `SHIPPED x${scale}, whole`, config: { ...base, scale } };

  const edges = [0, ...cuts, width];
  const slices = [];
  for (let i = 0; i < edges.length - 1; i++) slices.push([edges[i] / width, edges[i + 1] / width]);
  return {
    label: `SHIPPED x${scale}, ${slices.length} cols`,
    // Right to left, the way vertical Chinese reads.
    config: { ...base, scale, slices: slices.reverse() },
  };
}

function row(label, want, { text, confidence }) {
  const rate = cer(text, want);
  const mark = rate === 0 ? '**' : rate < 0.25 ? ' *' : '  ';
  return (
    `${mark} ${label.padEnd(22)} cer ${rate.toFixed(2)}  conf ${String(Math.round(confidence)).padStart(3)}  ` +
    `${JSON.stringify(text).slice(0, 32)}`
  );
}

async function bench(page, name, fixture) {
  const file = join(fixtureDir, `${name}.png`);
  if (!existsSync(file)) {
    console.log(`\n${name}: no ${name}.png in test/fixtures/ocr/ -- skipped\n`);
    return;
  }

  const want = fixture.text;
  if (!want) {
    // The image is there but nobody has written down what it says. Scoring against "" would
    // report a confident 1.00 for every sweep, which reads as a catastrophic result rather than
    // an unfinished fixture.
    console.log(`
${name}: image present but no expected text recorded -- skipped
`);
    return;
  }

  const bytes = await readFile(file);
  // PNG IHDR: width and height are big-endian uint32 at offsets 16 and 20.
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const src = `data:image/png;base64,${bytes.toString('base64')}`;
  const vertical = fixture.orientation === 'vertical';
  const base = {
    model: `chi_${fixture.script === 'traditional' ? 'tra' : 'sim'}${vertical ? '_vert' : ''}`,
    psm: vertical ? 5 : 3,
    scale: 1,
  };

  console.log(`\n=== ${name} ===`);
  console.log(`want ${JSON.stringify(want)}   (${width}x${height})`);
  if (fixture.note) console.log(`     ${fixture.note}`);
  console.log('');

  const results = [];
  const best = () => results.reduce((a, b) => (b.rate < a.rate ? b : a));
  const run = async (label, config) => {
    const got = await read(page, src, { ...base, ...config });
    console.log(row(label, want, got));
    results.push({ label, config, rate: cer(got.text, want), text: got.text });
  };

  console.log('-- size ------------------------------------------------------');
  for (const scale of [1, 2, 3, 4]) await run(`scale x${scale}`, { scale });

  const real = await shippedRun(page, src, base, vertical);
  await run(real.label, real.config);

  console.log('-- page segmentation -----------------------------------------');
  for (const psm of [4, 5, 6, 7, 10]) await run(`psm ${psm}`, { ...best().config, psm });

  console.log('-- declared resolution ---------------------------------------');
  for (const dpi of [96, 150, 300, 600]) await run(`dpi ${dpi}`, { ...best().config, dpi });

  // Simulates framing the snip more tightly. Artwork around a speech bubble gives Tesseract's
  // connected-component analysis plenty of stroke-shaped candidates, and it reports them as
  // characters -- so the question is whether excluding the art is enough on its own, or whether
  // the bubble would have to be found automatically.
  console.log('-- tighter framing -------------------------------------------');
  for (const inset of [0.05, 0.1, 0.15, 0.2]) {
    await run(`inset ${Math.round(inset * 100)}%`, {
      ...best().config,
      slice: [inset, 1 - inset],
      sliceY: [inset, 1 - inset],
    });
  }

  console.log('-- thresholding ----------------------------------------------');
  await run('otsu', { ...best().config, threshold: true });

  // Cheap, and the only thing that can turn "reads nothing at all" into "reads something".
  console.log('-- polarity --------------------------------------------------');
  await run('inverted', { ...best().config, invert: true });
  await run('inverted + otsu', { ...best().config, invert: true, threshold: true });

  console.log('-- model -----------------------------------------------------');
  for (const model of ['chi_sim_vert', 'chi_tra_vert', 'chi_sim', 'chi_tra']) {
    await run(model, { ...best().config, model });
  }

  // The axis the evidence actually points at: cells are being found correctly and the glyphs in
  // them misread, which no preprocessing step can reach.
  console.log('-- model quality ---------------------------------------------');
  // tessdata_best is deliberately absent. Its LSTM weights are floats, and *no* tesseract.js WASM
  // core exposes the float dot-product intrinsic they call -- both the LSTM-only build we ship
  // and the full SIMD build abort the whole process with "missing function: DotProductSSE". It is
  // not a configuration problem and there is nothing to sweep, so the most accurate Tesseract
  // models are simply unavailable to a browser extension. Leaving it in only crashed the bench.
  for (const repo of ['tessdata']) {
    const model = best().config.model ?? base.model;
    try {
      await run(repo, { ...best().config, dir: await altModel(repo, model), core: SHIPPED_CORE });
    } catch (error) {
      console.log(`   ${repo}: unavailable (${error.message})`);
    }
  }

  // The only question left. Stylised lettering and tilt are confounded in the panel that started
  // this -- it is both at once -- so on a fixture marked `straight` this sweep *adds* tilt and
  // measures what it costs with the font held constant. Rotating a real capture is fair game in a
  // way that generating one was not: the degradation is synthetic, the material is not.
  //
  // On an already-tilted fixture the same sweep runs the other way, asking whether straightening
  // it recovers anything.
  const tilting = fixture.straight === true;
  console.log(`-- tilt (${tilting ? 'degrading a straight capture' : 'correcting a tilted one'}) --`);
  for (const rotate of [-8, -6, -4, -2, 2, 4, 6, 8]) {
    await run(`tilt ${rotate > 0 ? '+' : ''}${rotate}\u00b0`, { ...best().config, rotate });
  }

  if (fixture.columns > 1) {
    console.log('-- one column at a time --------------------------------------');
    await run(`${fixture.columns} columns split`, { ...best().config, columns: fixture.columns });
  }

  // The experiment that separates the two remaining suspects, and needs no second fixture.
  //
  // Each glyph is cut out of the grid and read alone, keeping the best score across a range of
  // rotations. Best-per-cell means every glyph gets *its own* tilt corrected, whatever that tilt
  // happens to be -- which is more than a "straight" sample would achieve, since a straight panel
  // is only straight on average and its glyphs still jitter individually.
  //
  // So if a glyph is still misread here, tilt cannot be the reason and the lettering is.
  if (fixture.columns >= 1 && [...want].length > 1) {
    const chars = [...normalise(want)];
    const cols = fixture.columns;
    const rows = Math.ceil(chars.length / cols);
    const vertical = fixture.orientation === 'vertical';

    const cellAt = (i) => {
      // Vertical reads the rightmost column top to bottom, then the next column left.
      const col = vertical ? cols - 1 - Math.floor(i / rows) : i % cols;
      const rowIndex = vertical ? i % rows : Math.floor(i / cols);
      return {
        slice: [col / cols, (col + 1) / cols],
        sliceY: [rowIndex / rows, (rowIndex + 1) / rows],
        scale: 2,
        pad: 0.35,
      };
    };

    console.log('-- one glyph at a time, each straightened ---------------------');

    // A lone glyph has no reading direction, so the vertical model is the wrong tool and the
    // single-character modes become available. Which combination actually answers is not
    // guessable -- the first attempt at this returned an empty string for all ten cells, which
    // said nothing about the lettering and everything about asking chi_sim_vert for one
    // character. So probe on the first cell and only then sweep.
    const combos = [
      ['chi_sim', 10],
      ['chi_sim', 8],
      ['chi_sim', 6],
      ['chi_sim_vert', 5],
      ['chi_sim', 5],
    ];
    let chosen = null;
    for (const [model, psm] of combos) {
      const probe = await read(page, src, { ...base, ...cellAt(0), model, psm });
      console.log(`   probe ${model} psm ${psm}: ${JSON.stringify(probe.text)}`);
      if (probe.text) {
        chosen = { model, psm };
        break;
      }
    }

    if (!chosen) {
      // Report the null result as a null result. Nothing here is evidence about the font.
      console.log('   no mode reads a lone glyph at all -- inconclusive, not a finding');
    } else {
      console.log(`   using ${chosen.model} psm ${chosen.psm}\n`);
      let correct = 0;
      for (let i = 0; i < chars.length; i++) {
        let found = { rate: 1, text: '', rotate: 0 };
        for (const rotate of [0, -8, -6, -4, -2, 2, 4, 6, 8]) {
          const got = await read(page, src, { ...base, ...cellAt(i), ...chosen, rotate });
          const rate = cer(got.text, chars[i]);
          if (rate < found.rate) found = { rate, text: got.text, rotate };
          if (rate === 0) break;
        }
        if (found.rate === 0) correct++;
        console.log(
          `   ${String(i + 1).padStart(2)}. want ${chars[i]}  best ${JSON.stringify(found.text).padEnd(8)}` +
            ` at ${found.rotate > 0 ? '+' : ''}${found.rotate}°  ${found.rate === 0 ? 'ok' : ''}`,
        );
      }
      console.log(`   ${correct}/${chars.length} correct with each glyph isolated and straightened`);
    }
  }

  const winner = best();
  console.log(`\nbest: ${winner.label}  cer ${winner.rate.toFixed(2)}  ${JSON.stringify(winner.text)}`);
  console.log(`      ${JSON.stringify({ ...base, ...winner.config })}`);
}

// --- go ----------------------------------------------------------------------

const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chromium-family browser found. Set ZH_DIC_BROWSER=<path>.');
if (!existsSync(join(langPath, 'chi_sim.traineddata'))) {
  throw new Error('No models vendored -- run `npm run fetch-ocr` first.');
}

const expected = JSON.parse(await readFile(join(fixtureDir, 'expected.json'), 'utf8'));
const only = process.argv[2];
const names = Object.keys(expected).filter((k) => !k.startsWith('_') && (!only || k === only));

if (!names.length) {
  const png = (await readdir(fixtureDir)).filter((f) => f.endsWith('.png'));
  console.log(only ? `No fixture named "${only}" in expected.json.` : 'No fixtures registered.');
  console.log(png.length ? `Images present: ${png.join(', ')}` : 'No images in test/fixtures/ocr/.');
  process.exit(1);
}

// A generous protocol timeout: some of these canvases are large, and the default 30s trips on
// them in headless -- which presents as a hang rather than a slow draw.
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox'],
  protocolTimeout: 300000,
});
const page = await browser.newPage();
await page.setContent('<body></body>');

try {
  for (const name of names) await bench(page, name, expected[name]);
} finally {
  for (const worker of workers.values()) await worker.terminate();
  await browser.close();
}
