// Which recogniser model a set of settings asks for.
//
// Kept pure and separate from both the service worker and the offscreen document, so the mapping
// can be tested without a browser -- the same reasoning as action-state.js next door.

/** Every model tools/fetch-ocr.mjs vendors. Nothing else may be asked for. */
export const OCR_MODELS = ['chi_sim', 'chi_tra', 'chi_sim_vert', 'chi_tra_vert'];

/**
 * Captures smaller than this are doubled before recognition; larger ones are left alone.
 *
 * Between the fixtures that discriminate: 26k pixels reads twice as well doubled, while 48k and
 * 77k both read worse for it. Three points, so the boundary is somewhere in 26k..48k and 40k is
 * a guess inside it.
 */
const UPSCALE_BELOW = 40_000;

export const OCR_SCRIPTS = ['simplified', 'traditional'];
export const OCR_ORIENTATIONS = ['horizontal', 'vertical'];

/**
 * The traineddata name for the chosen script and direction.
 *
 * Unknown or missing values fall back to horizontal simplified rather than throwing: this runs on
 * the snip path, and a setting written by an older version should degrade to a reading the user
 * can correct rather than to no reading at all.
 *
 * @param {{ocrScript?: string, ocrOrientation?: string}} settings
 * @returns {string} one of OCR_MODELS
 */
export function ocrModel({ ocrScript, ocrOrientation } = {}) {
  const base = ocrScript === 'traditional' ? 'chi_tra' : 'chi_sim';
  return ocrOrientation === 'vertical' ? `${base}_vert` : base;
}

/** True for the models trained on columns rather than rows. They need their own segmentation. */
export function isVertical(model) {
  return model.endsWith('_vert');
}

/**
 * How much to enlarge a capture before recognising it: 2 or 1, never in between.
 *
 * Two separate findings, both measured, both counter-intuitive.
 *
 * Enlarging helps a small capture and hurts a large one, so a fixed multiplier is wrong. A flat
 * 2x -- tuned on one small capture -- turned a 162x473 snip that reads most of its text natively
 * into a single character, and did so exactly when the user had followed the advice to zoom in
 * for more pixels. The two compounded.
 *
 * But scaling to hit a *target size* is wrong too, because the factor matters as much as the
 * result. On the same capture, 2.00x scored 0.30 where 1.96x scored 0.60, and a capture that
 * reads at 1.00x collapsed completely at 1.14x. Doubling maps every pixel onto exactly four;
 * anything else resamples onto a grid that does not line up, and smears the glyph edges that
 * Tesseract is looking for. Integer factors only.
 *
 * Measured against the fixtures in test/fixtures/ocr:
 *
 *   118x220  (26k px)   0.60 at 1x, 0.30 at 2x   -> double
 *   162x473  (77k px)   0.50 at 1x, 1.00 at 2x   -> leave alone
 *   67x139, 264x40      0.00 either way          -> unaffected
 *
 * Fitted to four captures, two of which discriminate. `npm run bench-ocr` prints a SHIPPED row
 * showing what this returns for each one; re-check it before changing anything here.
 *
 * @returns {1 | 2}
 */
export function recogniserScale(width, height) {
  const pixels = Math.max(0, width) * Math.max(0, height);
  if (!pixels) return 1;
  return pixels < UPSCALE_BELOW ? 2 : 1;
}

/** Luminance below which a pixel counts as ink. Above it is paper, however grey. */
export const INK_BELOW = 160;

/**
 * Ink per column of pixels, for findColumnCuts.
 *
 * Takes raw RGBA so it stays pure and can be measured without a browser -- the canvas that
 * produced the pixels stays with the caller.
 *
 * @param {Uint8ClampedArray|number[]} pixels RGBA, four entries per pixel.
 */
export function inkProfile(pixels, width, height) {
  const profile = new Array(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const luminance = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
      if (luminance < INK_BELOW) profile[x]++;
    }
  }
  return profile;
}

/**
 * Where to cut a block of vertical text into its columns.
 *
 * Tesseract's page-segmentation mode 5 is supposed to find the columns itself, and on some
 * captures it does. On others it silently merges them and returns a couple of characters of
 * nonsense -- two bubbles from the same page, at the same scale, one read perfectly and one
 * returned "全半已收容完畢!" for twelve characters. Splitting that capture and reading each
 * column on its own took it from cer 0.50 to 0.00.
 *
 * The signal is simple on typeset text: a column gap is a run with essentially no ink in it.
 * This is given the ink profile -- one count per pixel across the text direction -- and returns
 * the interior cut positions, in order.
 *
 * Outer margins are deliberately never trimmed. Cropping to the ink turned a control that reads
 * perfectly into an empty string: Tesseract wants whitespace around a block to find its edges.
 *
 * @param {number[]} profile Ink count for each position across the text direction.
 * @param {number} depth How many pixels each of those counts was summed over.
 * @returns {number[]} Cut positions, empty when the block is a single column.
 */
export function findColumnCuts(profile, depth) {
  const width = profile.length;
  if (width < 4 || depth <= 0) return [];

  // A little ink is still a gap: antialiasing leaves a few grey pixels between columns.
  const blank = Math.max(1, depth * 0.005);
  // A gutter between columns is generous; anything narrow is the space inside or between glyphs.
  //
  // Measured across the fixtures, this is what separates a real gutter from incidental
  // whitespace: 10.5% and 13.4% gaps are columns worth splitting, 6.7% is too, and the 2.5% gap
  // in a hand-lettered capture is not -- splitting there took it from cer 0.30 to 0.50, because
  // the cut lands close enough to the strokes to clip them.
  const minGap = Math.max(3, Math.round(width * 0.05));

  // Margins are found first so a wide blank border is not mistaken for a column gap.
  let first = 0;
  while (first < width && profile[first] <= blank) first++;
  let last = width - 1;
  while (last >= 0 && profile[last] <= blank) last--;
  if (last <= first) return [];

  const cuts = [];
  let run = 0;
  for (let at = first; at <= last; at++) {
    if (profile[at] <= blank) {
      run++;
      continue;
    }
    if (run >= minGap) cuts.push(at - run / 2);
    run = 0;
  }
  return cuts;
}
