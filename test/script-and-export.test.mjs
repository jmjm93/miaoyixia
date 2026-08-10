// Tests the two settings added after a beta card came out silent: which script a note is
// written in, and which audio sources an export may draw on.
//
// The silent card was 於 (traditional-only, no Commons recording in either script). Fixing it
// needed the fallback; measuring it also showed that traditional headwords hit 4% against
// Commons where the same words in simplified hit 68%, hence the script normalisation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScript, buildCard } from '../extension/src/lib/card.js';
import { buildFields, sentenceWithWordBold } from '../extension/src/lib/anki-fields.js';
import { searchForms } from '../extension/src/lib/audio-source.js';
import { exportAudioPlan } from '../extension/src/lib/settings.js';

/** 个/個 — one character, two scripts, so tone colouring still lines up after a rewrite. */
const GE = ['个', '個', 'ge4', 'individual/this/that'];
/** 中国/中國 — two characters. */
const ZHONGGUO = ['中国', '中國', 'Zhong1 guo2', 'China'];
/** 好 — identical in both scripts, so the shard leaves the traditional column blank. */
const HAO = ['好', '', 'hao3', 'good/well'];

test('rewrites the headword to the requested script', () => {
  const card = buildCard('個', GE);
  assert.equal(applyScript(card, 'simplified').headword, '个');
  assert.equal(applyScript(card, 'traditional').headword, '個');
  assert.equal(applyScript(card, 'hovered').headword, '個', 'the default changes nothing');
});

test('works from either direction', () => {
  // Mining simplified text while studying traditional is just as real a case.
  const card = buildCard('个', GE);
  assert.equal(applyScript(card, 'traditional').headword, '個');
  assert.equal(applyScript(card, 'simplified').headword, '个');
});

test('leaves a script-neutral word alone', () => {
  const card = buildCard('好', HAO);
  for (const pref of ['hovered', 'simplified', 'traditional']) {
    assert.equal(applyScript(card, pref).headword, '好', pref);
  }
});

test('never mangles the card it was given', () => {
  const card = buildCard('個', GE);
  const rewritten = applyScript(card, 'simplified');
  assert.equal(card.headword, '個', 'the original is untouched');
  // Everything a note needs must survive the rewrite.
  for (const key of ['pinyin', 'pinyinNumbered', 'senses', 'simplified', 'traditional', 'sentence']) {
    assert.deepEqual(rewritten[key], card[key], key);
  }
});

test('keeps tone colouring aligned after a rewrite', () => {
  const card = applyScript(buildCard('中國', ZHONGGUO), 'simplified');
  const html = buildFields({ Color: 'colourHanzi' }, card).Color;
  // One span per character, not the plain-text fallback a length mismatch would trigger.
  assert.equal(html.match(/<span/g)?.length, 2, html);
  assert.ok(html.includes('中') && html.includes('国'), html);
  assert.ok(!html.includes('國'), 'the traditional form should be gone');
});

test('still bolds the sentence using the form the page actually used', () => {
  // The page said 個; rewriting the headword to 个 must not stop the sentence being marked up,
  // because 个 does not occur in it.
  const card = applyScript(buildCard('個', GE, { sentence: '這個很好。' }), 'simplified');
  assert.equal(card.headword, '个');
  assert.equal(sentenceWithWordBold(card), '這<b>個</b>很好。');
});

test('falls back rather than corrupting a card of unequal length', () => {
  // Not expected from CC-CEDICT, but a shard row could pair forms of different lengths, and a
  // rewrite there would silently misalign every tone colour on the card.
  const odd = { ...buildCard('X', GE), simplified: '一二三' };
  assert.equal(applyScript(odd, 'simplified').headword, 'X');
});

test('searches the hovered form first, then the other script', () => {
  // The hovered form leads because legacy Zh-tw- files do exist, but stopping there loses most
  // of the coverage: Lingua Libre names its Mandarin files in simplified.
  assert.deepEqual(
    searchForms({ word: '個', simplified: '个', traditional: '個' }),
    ['個', '个'],
  );
  assert.deepEqual(
    searchForms({ word: '个', simplified: '个', traditional: '個' }),
    ['个', '個'],
  );
});

test('does not search the same form twice', () => {
  assert.deepEqual(searchForms({ word: '好', simplified: '好', traditional: '好' }), ['好']);
  assert.deepEqual(searchForms({ word: '好' }), ['好']);
});

test('maps each audio source onto what an export can actually use', () => {
  // 'voice' cannot mean the OS voice here: nothing can capture SpeechSynthesis to a file, so it
  // is served by TTS instead. Before this existed the export ignored the setting entirely.
  assert.deepEqual(exportAudioPlan('auto'), { recording: true, tts: true });
  assert.deepEqual(exportAudioPlan('voice'), { recording: false, tts: true });
  assert.deepEqual(exportAudioPlan('recording'), { recording: true, tts: false });
  assert.deepEqual(exportAudioPlan('off'), { recording: false, tts: false });
});

test('an unrecognised audio source behaves like the default', () => {
  // Settings written by a newer version must not silence the audio field.
  assert.deepEqual(exportAudioPlan(undefined), { recording: true, tts: true });
  assert.deepEqual(exportAudioPlan('something-new'), { recording: true, tts: true });
});
