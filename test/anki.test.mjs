// Tests the Anki export logic: token rendering, field mapping, duplicate classification and
// create-on-demand. All offline — the AnkiConnect transport is injected, so nothing here needs
// Anki running and nothing can touch a real collection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDictStub, candidatesFor } from './dict-stub.mjs';
import {
  TOKENS,
  buildFields,
  colouredHanzi,
  colouredPinyin,
  escapeHtml,
  primaryField,
  sentenceWithWordBold,
} from '../extension/src/lib/anki-fields.js';
import { createClient, ensureTarget, reconcileMapping } from '../extension/src/lib/anki.js';
import { DEFAULT_SETTINGS } from '../extension/src/lib/settings.js';

installDictStub();

/** The first card for a word, as the popup would hold it. */
async function cardFor(word, context = {}) {
  const candidates = await candidatesFor(word, context);
  return candidates.find((c) => c.headword === word).cards[0];
}

/** Records every call, and answers from a canned collection. */
function fakeAnki({ decks = [], models = {}, canAdd = [], addNoteId = 1 } = {}) {
  const calls = [];
  const transport = async (action, params) => {
    calls.push({ action, params });
    switch (action) {
      case 'version': return 6;
      case 'deckNames': return decks;
      case 'modelNames': return Object.keys(models);
      case 'modelFieldNames': return models[params.modelName] ?? [];
      case 'canAddNotesWithErrorDetail': return canAdd;
      case 'addNote': return addNoteId;
      case 'storeMediaFile': return 'stored.wav';
      case 'createDeck': decks.push(params.deck); return 1;
      case 'createModel': models[params.modelName] = params.inOrderFields; return {};
      default: throw new Error(`unexpected action ${action}`);
    }
  };
  return { client: createClient(transport), calls, decks, models };
}

// --- tokens ------------------------------------------------------------------

test('dictionary text is escaped, since Anki fields are HTML', () => {
  assert.equal(escapeHtml('a < b & "c"'), 'a &lt; b &amp; &quot;c&quot;');
});

test('tone-colours the word one span per character', async () => {
  // 中国菜 is tones 1, 2, 4.
  assert.equal(
    colouredHanzi(await cardFor('中国菜')),
    '<span class="tone1">中</span><span class="tone2">国</span><span class="tone4">菜</span>',
  );
});

test('falls back to plain text when characters and syllables do not align', () => {
  // A headword mixing Latin has more characters than syllables; wrong colours would be worse
  // than none.
  const card = { headword: 'AA制', pinyin: 'A A zhì', pinyinNumbered: 'A A zhi4', syllables: [{ text: 'zhì', tone: 4 }] };
  assert.equal(colouredHanzi(card), 'AA制');
});

test('tone-colours pinyin per syllable and keeps the toneless reading in a comment', async () => {
  const html = colouredPinyin(await cardFor('中国'));
  assert.match(html, /<span class="tone1">Zhōng<\/span> <span class="tone2">guó<\/span>/);
  assert.match(html, /<!-- Zhong guo -->/, 'toneless reading, as Chinese Support 3 writes it');
});

test('tone 0 tokens fall back to tone5, the only classes templates define', () => {
  const card = { headword: '·', pinyin: '·', pinyinNumbered: '·', syllables: [{ text: '·', tone: 0 }] };
  assert.equal(colouredHanzi(card), '<span class="tone5">·</span>');
});

test('emboldens the word inside its sentence', async () => {
  const card = await cardFor('中国菜', { sentence: '我喜欢吃中国菜。' });
  assert.equal(sentenceWithWordBold(card), '我喜欢吃<b>中国菜</b>。');
});

test('escapes the sentence before emboldening, so page text cannot inject markup', () => {
  const card = { headword: 'x', sentence: '<script>bad()</script> x' };
  const html = sentenceWithWordBold(card);
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('<b>x</b>'));
});

test('every token id is unique and renders a string for a real card', async () => {
  const card = await cardFor('你好', { sentence: '你好世界。', url: 'https://example.com/', title: 'Example' });
  assert.equal(new Set(TOKENS.map((t) => t.id)).size, TOKENS.length);
  for (const token of TOKENS) {
    assert.equal(typeof token.render(card, { audioFilename: 'a.wav' }), 'string', token.id);
  }
});

test('the audio token is empty unless a media file was actually stored', async () => {
  const card = await cardFor('你好');
  const audio = TOKENS.find((t) => t.id === 'audio');
  assert.equal(audio.render(card, {}), '');
  assert.equal(audio.render(card, { audioFilename: 'x.wav' }), '[sound:x.wav]');
});

// --- mapping -----------------------------------------------------------------

test('builds fields from the shipped default mapping', async () => {
  const card = await cardFor('中国菜');
  const fields = buildFields(DEFAULT_SETTINGS.ankiFields, card, { audioFilename: 'x.wav' });

  assert.deepEqual(Object.keys(fields), ['Hanzi', 'Color', 'Pinyin', 'English', 'Sound']);
  assert.equal(fields.Hanzi, '中国菜');
  assert.match(fields.Color, /^<span class="tone1">中/);
  assert.match(fields.Pinyin, /tone1/);
  assert.equal(fields.English, 'Chinese cuisine');
  assert.equal(fields.Sound, '[sound:x.wav]');
});

test('field names are arbitrary — a differently-named note type works unchanged', async () => {
  const card = await cardFor('中国菜');
  // Nothing in the code refers to "Hanzi" or "Color"; only this mapping does.
  const fields = buildFields(
    { Chinese: 'headword', Reading: 'pinyin', Definition: 'sensesNumbered', 'Example - Chinese': 'sentence' },
    card,
  );
  assert.deepEqual(Object.keys(fields), ['Chinese', 'Reading', 'Definition', 'Example - Chinese']);
  assert.equal(fields.Chinese, '中国菜');
  assert.equal(fields.Definition, '1. Chinese cuisine');
});

test('an unknown token yields an empty field rather than losing the note', async () => {
  const card = await cardFor('你好');
  assert.deepEqual(buildFields({ Front: 'headword', Weird: 'from-the-future' }, card).Weird, '');
});

test('reconciling drops fields the note type lacks and adds ones it has', () => {
  const mapping = reconcileMapping({ Hanzi: 'headword', Gone: 'senses' }, ['Hanzi', 'Extra']);
  assert.deepEqual(mapping, { Hanzi: 'headword', Extra: 'none' });
});

test('the front of an auto-created note type is whichever field holds the word', () => {
  assert.equal(primaryField({ Color: 'colourHanzi', Hanzi: 'headword' }), 'Hanzi');
  assert.equal(primaryField({ Color: 'colourHanzi', English: 'senses' }), 'Color');
  assert.equal(primaryField({ Foo: 'senses', Bar: 'pinyin' }), 'Foo', 'falls back to the first field');
});

// --- client ------------------------------------------------------------------

test('classifies a duplicate distinctly from other refusals', async () => {
  const { client } = fakeAnki({
    canAdd: [
      { canAdd: false, error: 'cannot create note because it is a duplicate' },
      { canAdd: false, error: 'cannot create note because it is empty' },
      { canAdd: true },
    ],
  });

  assert.deepEqual(await client.inspect([{}, {}, {}]), [
    { canAdd: false, duplicate: true, error: 'cannot create note because it is a duplicate' },
    { canAdd: false, duplicate: false, error: 'cannot create note because it is empty' },
    { canAdd: true, duplicate: false, error: '' },
  ]);
});

test('creates the deck and note type when missing, and says what it made', async () => {
  const { client, calls, models } = fakeAnki({ decks: [], models: {} });
  const created = await ensureTarget(client, {
    deck: 'Mandarin::Mining',
    model: 'My Type',
    fields: DEFAULT_SETTINGS.ankiFields,
  });

  assert.deepEqual(created, ['deck "Mandarin::Mining"', 'note type "My Type"']);
  assert.deepEqual(models['My Type'], ['Hanzi', 'Color', 'Pinyin', 'English', 'Sound']);

  const createModel = calls.find((c) => c.action === 'createModel');
  assert.match(createModel.params.cardTemplates[0].Front, /\{\{Hanzi\}\}/, 'word on the front');
  assert.match(createModel.params.css, /\.tone1/, 'tone CSS, or coloured tokens render plain');
  assert.equal(createModel.params.isCloze, false);
});

test('creates nothing when the deck and note type already exist', async () => {
  const { client, calls } = fakeAnki({ decks: ['D'], models: { M: ['Hanzi'] } });
  assert.deepEqual(await ensureTarget(client, { deck: 'D', model: 'M', fields: { Hanzi: 'headword' } }), []);
  assert.ok(!calls.some((c) => c.action === 'createDeck' || c.action === 'createModel'));
});

test('creates only what is missing', async () => {
  const { client, calls } = fakeAnki({ decks: ['D'], models: {} });
  const created = await ensureTarget(client, { deck: 'D', model: 'M', fields: { Hanzi: 'headword' } });
  assert.deepEqual(created, ['note type "M"']);
  assert.ok(!calls.some((c) => c.action === 'createDeck'));
});

test('an unreachable Anki surfaces as a typed error, not a silent failure', async () => {
  const client = createClient(async () => {
    throw new Error('Failed to fetch');
  });
  await assert.rejects(() => client.version(), /Failed to fetch/);
});
