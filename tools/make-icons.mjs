// Generates the extension's PNG icons: a 中 glyph on a rounded blue tile.
//
// Chrome only accepts raster icons in the manifest, and committing binaries for
// something this simple is worse than regenerating them. Everything is drawn at 4x and
// box-downsampled, which is all the antialiasing a 16px icon needs.

import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

/**
 * Two variants: the normal icon, and a desaturated one shown while the extension is switched
 * off. Grey-vs-blue is legible at 16px in a way a small badge alone isn't.
 */
const VARIANTS = {
  '': { bg: [37, 99, 235], fg: [255, 255, 255] }, // --zh-accent from popup.css
  '-off': { bg: [138, 143, 152], fg: [242, 243, 245] },
};

/** Signed-distance test for a rounded square covering the whole canvas. */
function insideTile(x, y, n, radius) {
  const dx = Math.max(radius - x, x - (n - radius), 0);
  const dy = Math.max(radius - y, y - (n - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}

/**
 * The strokes of 中, as fractions of the tile: a boxed 口 with a vertical stroke
 * running through and past it. Legible even at 16px, unlike anything with more detail.
 */
function glyphRects(n) {
  const stroke = Math.max(1, n * 0.085);
  const boxLeft = n * 0.26;
  const boxRight = n * 0.74;
  const boxTop = n * 0.33;
  const boxBottom = n * 0.67;

  return [
    [boxLeft, boxTop, stroke, boxBottom - boxTop], // 口 left
    [boxRight - stroke, boxTop, stroke, boxBottom - boxTop], // 口 right
    [boxLeft, boxTop, boxRight - boxLeft, stroke], // 口 top
    [boxLeft, boxBottom - stroke, boxRight - boxLeft, stroke], // 口 bottom
    [(n - stroke) / 2, n * 0.15, stroke, n * 0.7], // the vertical through-stroke
  ];
}

function renderRGBA(size, { bg, fg }) {
  const n = size * SUPERSAMPLE;
  const hi = new Uint8Array(n * n * 4);
  const radius = n * 0.22;
  const rects = glyphRects(n);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!insideTile(px, py, n, radius)) continue;

      const onGlyph = rects.some(([rx, ry, rw, rh]) => px >= rx && px <= rx + rw && py >= ry && py <= ry + rh);
      const [r, g, b] = onGlyph ? fg : bg;
      const i = (y * n + x) * 4;
      hi[i] = r;
      hi[i + 1] = g;
      hi[i + 2] = b;
      hi[i + 3] = 255;
    }
  }

  // Box-downsample in premultiplied space so transparent edges don't fringe.
  const out = Buffer.alloc(size * size * 4);
  const area = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const i = ((y * SUPERSAMPLE + sy) * n + x * SUPERSAMPLE + sx) * 4;
          const alpha = hi[i + 3] / 255;
          r += hi[i] * alpha;
          g += hi[i + 1] * alpha;
          b += hi[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      // Un-premultiply back to straight alpha for the PNG.
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / area) * 255);
    }
  }
  return out;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // truecolour with alpha
  // bytes 10-12: deflate compression, adaptive filtering, no interlacing (all zero)

  // Each scanline is prefixed with its filter type; 0 means "none".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
await mkdir(outDir, { recursive: true });

for (const [suffix, palette] of Object.entries(VARIANTS)) {
  for (const size of SIZES) {
    const png = encodePNG(renderRGBA(size, palette), size);
    const name = `icon${suffix}-${size}.png`;
    await writeFile(join(outDir, name), png);
    console.log(`icons/${name}  ${png.length} bytes`);
  }
}
