// Resizes the supplied artwork in art/ into the PNGs the manifest needs.
//
// Chrome only accepts raster icons, and Node has no image decoder in its standard library, so
// the browser that is already a devDependency for the tests does the work. The results are
// committed, so an ordinary build needs no browser -- only re-running this does.
//
// Two things the source images require, both measured rather than assumed:
//
//   Cropping. Roughly a third of each 1024px canvas is transparent padding. Scaling the whole
//   canvas down would leave the cat markedly smaller than neighbouring toolbar icons.
//
//   Cropping *independently*. The two tiles aren't the same size (637px vs 695px), so a shared
//   crop would make the icon visibly change size when toggled. Each is cropped to its own
//   bounds and squared, which lands them at matching final dimensions.
//
//   node tools/make-icons.mjs                  write icon-*.png and icon-off-*.png
//   node tools/make-icons.mjs --preview x.png  contact sheet for checking the result

import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZES = [16, 32, 48, 128];

/** Output suffix -> source file. '' is the enabled icon, '-off' the sleeping one. */
const SOURCES = {
  '': 'art/ONicon.png',
  '-off': 'art/OFFicon.png',
};

/**
 * Alpha below this counts as empty when finding the crop. Above zero so that a soft glow or
 * drop shadow around the tile doesn't inflate the bounding box.
 */
const ALPHA_FLOOR = 24;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'extension', 'icons');

const CANDIDATE_BROWSERS = [
  process.env.ZH_DIC_BROWSER,
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? true);
}

for (const path of Object.values(SOURCES)) {
  if (!existsSync(join(root, path))) {
    console.error(`Missing source artwork: ${path}`);
    process.exit(1);
  }
}

const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chromium-family browser found. Set ZH_DIC_BROWSER=<path>.');
  process.exit(1);
}

// Same-origin server: a canvas can't read pixels from a file:// or cross-origin image.
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>icons</title>');
    return;
  }
  try {
    // Read before writing the header, or a missing file leaves the response half-sent.
    const body = await readFile(join(root, decodeURIComponent(req.url).slice(1)));
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });

/**
 * Crop to the artwork's own bounds, centre it in a square, then step down to `sizes`.
 * Returns data URLs keyed by size, plus the crop that was used, for reporting.
 */
async function resize(url, sizes, alphaFloor) {
  return page.evaluate(
    async ([src, targets, floor]) => {
      const img = new Image();
      img.src = src;
      await img.decode();

      const measure = document.createElement('canvas');
      measure.width = img.naturalWidth;
      measure.height = img.naturalHeight;
      const mctx = measure.getContext('2d', { willReadFrequently: true });
      mctx.drawImage(img, 0, 0);
      const { data, width, height } = mctx.getImageData(0, 0, measure.width, measure.height);

      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] >= floor) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) throw new Error('image is entirely transparent');

      const cropW = maxX - minX + 1;
      const cropH = maxY - minY + 1;
      // Square by the longer side so nothing is distorted, and centre the shorter one.
      const side = Math.max(cropW, cropH);

      let canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      let ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        img,
        minX,
        minY,
        cropW,
        cropH,
        Math.round((side - cropW) / 2),
        Math.round((side - cropH) / 2),
        cropW,
        cropH,
      );

      const out = {};
      for (const target of targets) {
        // Step down by halves first: a single 695->16 draw loses the thin outlines, where
        // successive halving keeps them.
        let stage = canvas;
        while (stage.width > target * 2) {
          const next = document.createElement('canvas');
          next.width = Math.max(target, Math.floor(stage.width / 2));
          next.height = next.width;
          const nctx = next.getContext('2d');
          nctx.imageSmoothingEnabled = true;
          nctx.imageSmoothingQuality = 'high';
          nctx.drawImage(stage, 0, 0, next.width, next.height);
          stage = next;
        }

        const final = document.createElement('canvas');
        final.width = target;
        final.height = target;
        const fctx = final.getContext('2d');
        fctx.imageSmoothingEnabled = true;
        fctx.imageSmoothingQuality = 'high';
        fctx.drawImage(stage, 0, 0, target, target);
        out[target] = final.toDataURL('image/png');
      }

      return { images: out, crop: { x: minX, y: minY, w: cropW, h: cropH, side } };
    },
    [url, sizes, alphaFloor],
  );
}

const decode = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

await mkdir(iconsDir, { recursive: true });
const rendered = {};

for (const [suffix, source] of Object.entries(SOURCES)) {
  const { images, crop } = await resize(`${origin}/${source}`, SIZES, ALPHA_FLOOR);
  rendered[suffix] = images;

  console.log(`${source}  crop ${crop.w}x${crop.h} at (${crop.x},${crop.y}) -> square ${crop.side}`);
  for (const size of SIZES) {
    const png = decode(images[size]);
    const file = `icon${suffix}-${size}.png`;
    await writeFile(join(iconsDir, file), png);
    console.log(`  icons/${file}  ${png.length} bytes`);
  }
}

const previewPath = arg('preview');
if (previewPath) {
  const row = (label, suffix) => `
    <tr><th>${label}</th>${SIZES.map(
      (s) =>
        `<td><img src="${rendered[suffix][s]}" width="${s}" height="${s}" style="image-rendering:pixelated"><i>${s}</i></td>`,
    ).join('')}</tr>`;

  await page.setContent(
    `<style>
       body{margin:0;padding:24px;background:#f6f7f9;font:13px system-ui}
       table{border-collapse:collapse}
       th{text-align:left;padding-right:20px;font:600 15px system-ui}
       td{padding:14px 20px;text-align:center;vertical-align:bottom}
       i{display:block;color:#6b7280;font-style:normal;margin-top:8px}
       tr+tr td,tr+tr th{border-top:1px solid #e2e5ea}
     </style><table>${row('enabled', '')}${row('off', '-off')}</table>`,
    { waitUntil: 'domcontentloaded' },
  );
  const sheet = await page.$('table');
  await writeFile(previewPath, await sheet.screenshot());
  console.log(`\nwrote ${previewPath}`);
}

await browser.close();
server.close();
