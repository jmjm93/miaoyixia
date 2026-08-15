// Which recogniser model a set of settings asks for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { OCR_MODELS, findColumnCuts, ocrModel, isVertical, recogniserScale } from '../extension/src/lib/ocr.js';
import { DEFAULT_SETTINGS } from '../extension/src/lib/settings.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('each combination of script and direction names its own model', () => {
  assert.equal(ocrModel({ ocrScript: 'simplified', ocrOrientation: 'horizontal' }), 'chi_sim');
  assert.equal(ocrModel({ ocrScript: 'traditional', ocrOrientation: 'horizontal' }), 'chi_tra');
  assert.equal(ocrModel({ ocrScript: 'simplified', ocrOrientation: 'vertical' }), 'chi_sim_vert');
  assert.equal(ocrModel({ ocrScript: 'traditional', ocrOrientation: 'vertical' }), 'chi_tra_vert');
});

test('the four combinations are exactly the four vendored models', () => {
  const named = new Set();
  for (const ocrScript of ['simplified', 'traditional']) {
    for (const ocrOrientation of ['horizontal', 'vertical']) {
      named.add(ocrModel({ ocrScript, ocrOrientation }));
    }
  }
  // Nothing can be selected that fetch-ocr.mjs does not vendor, and nothing is vendored that
  // cannot be selected.
  assert.deepEqual([...named].sort(), [...OCR_MODELS].sort());
});

test('a setting written by some other version falls back rather than throwing', () => {
  // This runs on the snip path. A model name nobody vendored would fail the whole read; falling
  // back gives a reading the user can see is wrong and correct with two clicks.
  assert.equal(ocrModel({}), 'chi_sim');
  assert.equal(ocrModel(), 'chi_sim');
  assert.equal(ocrModel({ ocrScript: 'pinyin', ocrOrientation: 'diagonal' }), 'chi_sim');
});

test('the defaults name a real model', () => {
  assert.ok(OCR_MODELS.includes(ocrModel(DEFAULT_SETTINGS)));
});

test('only the vertical models are treated as vertical', () => {
  // This is what decides whether page-segmentation mode 5 is applied, and mode 5 is the whole
  // difference between an 87%-confidence reading and a 21% one.
  assert.equal(isVertical('chi_sim_vert'), true);
  assert.equal(isVertical('chi_tra_vert'), true);
  assert.equal(isVertical('chi_sim'), false);
  assert.equal(isVertical('chi_tra'), false);
});

test('every model the settings can name is actually on disk', { skip: modelsSkip() }, () => {
  for (const model of OCR_MODELS) {
    const file = join(root, 'extension', 'data', 'ocr', `${model}.traineddata`);
    assert.ok(existsSync(file), `${model}.traineddata is missing -- run \`npm run fetch-ocr\``);
  }
});

function modelsSkip() {
  const any = existsSync(join(root, 'extension', 'data', 'ocr', 'chi_sim.traineddata'));
  return any ? false : 'run `npm run fetch-ocr` to vendor the recogniser';
}

// --- how much to enlarge a capture -------------------------------------------

test('small captures are doubled and large ones are left alone', () => {
  // The two fixtures that discriminate, by their real dimensions. A flat 2x was shipped first
  // and turned the larger one -- which reads half its text natively -- into a single character.
  assert.equal(recogniserScale(118, 220), 2, '26k pixels should be doubled');
  assert.equal(recogniserScale(162, 473), 1, '77k pixels should be left alone');
});

test('the factor is only ever 1 or 2', () => {
  // Not a rounding detail: at the same output size, 1.96x scored twice the error of 2.00x, and a
  // capture that reads fine at 1.00x collapsed entirely at 1.14x. Doubling maps each pixel onto
  // exactly four; any other factor resamples onto a grid that does not line up and smears the
  // edges the recogniser is looking for.
  for (const [w, h] of [[10, 10], [67, 139], [264, 40], [200, 200], [500, 500], [4000, 4000]]) {
    assert.ok([1, 2].includes(recogniserScale(w, h)), `${w}x${h} gave ${recogniserScale(w, h)}`);
  }
});

test('a capture is never shrunk, and degenerate sizes do not throw', () => {
  // This runs on the snip path; a zero-sized crop should cost a bad reading at worst.
  assert.equal(recogniserScale(4000, 4000), 1);
  assert.equal(recogniserScale(0, 0), 1);
  assert.equal(recogniserScale(-5, 100), 1);
  assert.equal(recogniserScale(undefined, undefined), 1);
});

// --- splitting a block into its columns ---------------------------------------

/** An ink profile: `columns` blocks of `ink`, separated by `gap` blank positions. */
function profileOf({ margin = 8, columns = 2, block = 40, gap = 12, ink = 30 } = {}) {
  const profile = new Array(margin).fill(0);
  for (let c = 0; c < columns; c++) {
    if (c) profile.push(...new Array(gap).fill(0));
    profile.push(...new Array(block).fill(ink));
  }
  profile.push(...new Array(margin).fill(0));
  return profile;
}

test('a gap between columns becomes a cut, and its position is between them', () => {
  // The bug this fixes: Tesseract merged two columns and returned a few characters of nonsense
  // for twelve. Splitting the same capture took it from cer 0.50 to 0.00.
  const cuts = findColumnCuts(profileOf({ columns: 2 }), 100);
  assert.equal(cuts.length, 1);
  // Between the end of the first block (8+40=48) and the start of the second (60).
  assert.ok(cuts[0] > 48 && cuts[0] < 60, `cut landed at ${cuts[0]}`);
});

test('three columns give two cuts', () => {
  assert.equal(findColumnCuts(profileOf({ columns: 3 }), 100).length, 2);
});

test('a single column is left alone', () => {
  assert.deepEqual(findColumnCuts(profileOf({ columns: 1 }), 100), []);
});

test('the outer margins are never cut', () => {
  // Cropping to the ink strips the whitespace Tesseract wants around a block, and turned a
  // control that reads perfectly into an empty string.
  const wide = findColumnCuts(profileOf({ margin: 40, columns: 1 }), 100);
  assert.deepEqual(wide, [], 'a wide border was mistaken for a column gap');

  for (const cut of findColumnCuts(profileOf({ margin: 40, columns: 2 }), 100)) {
    assert.ok(cut > 40, `cut at ${cut} is inside the left margin`);
  }
});

test('gaps inside and between glyphs are not column gaps', () => {
  // Characters have whitespace in them. Only a run wide relative to the block counts.
  const profile = profileOf({ columns: 1, block: 200 });
  profile[60] = 0;
  profile[61] = 0;
  assert.deepEqual(findColumnCuts(profile, 100), []);
});

test('faint ink between columns still reads as a gap', () => {
  // Antialiasing leaves a few grey pixels where the columns nearly touch.
  const profile = profileOf({ columns: 2 });
  for (let i = 48; i < 60; i++) profile[i] = 1;
  assert.equal(findColumnCuts(profile, 400).length, 1);
});

test('a blank or tiny profile yields no cuts rather than throwing', () => {
  assert.deepEqual(findColumnCuts([], 100), []);
  assert.deepEqual(findColumnCuts([0, 0, 0], 100), []);
  assert.deepEqual(findColumnCuts(new Array(100).fill(0), 100), []);
  assert.deepEqual(findColumnCuts(profileOf(), 0), []);
});
