import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { buildJapaneseDictionary, japaneseMatches, buildJapaneseCard } from '../extension/src/lib/japanese.js';
import { dictionaryFromArchive } from '../extension/src/lib/archive.js';
import { JAPANESE_ORIGINS, validateJapaneseModel } from '../extension/src/lib/japanese-store.js';
import { DEFAULT_SETTINGS } from '../extension/src/lib/settings.js';
import { ocrModel } from '../extension/src/lib/ocr.js';
import { shardFor } from '../extension/src/lib/shard.js';
import { segment } from '../extension/src/lib/segment.js';
import { JAPANESE_FIXTURE, word, archiveFor, fakeModel } from './japanese-fixture.mjs';

const built = buildJapaneseDictionary(JAPANESE_FIXTURE);
const lookup = (text) => japaneseMatches(text, async (index) => built.shards[index], built.meta.maxWordLength);

test('Japanese starts disabled, Chinese is selected, and download hosts are optional', () => {
  assert.equal(DEFAULT_SETTINGS.japaneseEnabled, false);
  assert.equal(DEFAULT_SETTINGS.lookupLanguage, 'zh');
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
  for (const origin of JAPANESE_ORIGINS) {
    assert.ok(manifest.optional_host_permissions.includes(origin));
    assert.ok(!manifest.host_permissions.includes(origin));
  }
  assert.equal(ocrModel({ lookupLanguage: 'ja', japaneseEnabled: false }), 'chi_sim');
  assert.equal(ocrModel({ lookupLanguage: 'ja', japaneseEnabled: true }), 'jpn');
  assert.equal(ocrModel({ lookupLanguage: 'ja', japaneseEnabled: true, ocrOrientation: 'vertical' }), 'jpn_vert');
});

test('mixed scripts, kana-only words and prolonged sound marks look up locally', async () => {
  for (const text of ['食べる', 'たべる', 'ありがとう', 'コーヒー', '学校']) {
    const matches = await lookup(text);
    assert.equal(matches[0].length, [...text].length);
    assert.ok(matches[0].entries[0].senses.length);
  }
});

test('common conjugations return dictionary forms while consuming the entire surface', async () => {
  for (const [surface, lemma] of [
    ['食べました', '食べる'], ['食べない', '食べる'], ['食べている', '食べる'],
    ['読んだ', '読む'], ['読みませんでした', '読む'], ['読んでいる', '読む'],
    ['高かった', '高い'], ['高くない', '高い'], ['しました', 'する'],
    ['来ました', '来る'], ['きました', 'くる'], ['行った', '行く'],
  ]) {
    const result = (await lookup(surface))[0];
    assert.equal(result.headword, surface);
    assert.equal(result.length, [...surface].length);
    assert.ok(result.entries.some((entry) => entry.word === lemma), `${surface} should find ${lemma}`);
  }
});

test('POS checks prevent adjective deinflection from selecting an unrelated noun', async () => {
  const dict = buildJapaneseDictionary({ ...JAPANESE_FIXTURE, words: [word('x', '高い', 'たかい', 'fake noun')] });
  assert.deepEqual(await japaneseMatches('高かった', async (index) => dict.shards[index]), []);
});

test('spelling, reading and sense restrictions remain associated', () => {
  const entry = {
    id: 'r', kanji: [{ text: '上手' }, { text: '巧い' }],
    kana: [{ text: 'じょうず', appliesToKanji: ['上手'] }, { text: 'うまい', appliesToKanji: ['巧い'] }],
    sense: [
      { appliesToKanji: ['上手'], appliesToKana: ['じょうず'], partOfSpeech: ['adj-na'], gloss: [{ lang: 'eng', text: 'skillful' }] },
      { appliesToKanji: ['巧い'], appliesToKana: ['うまい'], partOfSpeech: ['adj-i'], gloss: [{ lang: 'eng', text: 'good' }] },
    ],
  };
  const { shards } = buildJapaneseDictionary({ ...JAPANESE_FIXTURE, words: [entry] });
  assert.deepEqual(shards[shardFor('上手')]['上手'].map((row) => row.reading), ['じょうず']);
  assert.deepEqual(shards[shardFor('巧い')]['巧い'][0].senses, ['good']);
});

test('Japanese cards preserve the lemma, surface, reading and source context', async () => {
  const match = (await lookup('食べました'))[0];
  const card = buildJapaneseCard(match.headword, match.entries[0], { sentence: '食べました。', url: 'https://example.com/' });
  assert.equal(card.headword, '食べる');
  assert.equal(card.hovered, '食べました');
  assert.equal(card.reading, 'たべる');
  assert.equal(card.language, 'ja');
  assert.equal(card.sentence, '食べました。');
});

test('OCR segmentation uses inflected matches and covers unknown punctuation', async () => {
  const text = '私はコーヒーを食べました。';
  const chars = [...text];
  const matches = await Promise.all(chars.map((_, start) => lookup(chars.slice(start).join(''))));
  const spans = segment(chars.length, matches.map((at) => at.map((match) => match.length)));
  assert.deepEqual(spans.map(({ start, length }) => chars.slice(start, start + length).join('')), ['私', 'は', 'コーヒー', 'を', '食べました', '。']);
});

test('dictionary archive decoding rejects missing, malformed and truncated input', async () => {
  assert.deepEqual(await dictionaryFromArchive(archiveFor()), JAPANESE_FIXTURE);
  await assert.rejects(dictionaryFromArchive(gzipSync(Buffer.alloc(512))), /No dictionary/);
  await assert.rejects(dictionaryFromArchive(new Uint8Array([1, 2, 3])));
  assert.throws(() => buildJapaneseDictionary({ words: [], languages: ['eng'] }), /not an English/);
  validateJapaneseModel(fakeModel());
  assert.throws(() => validateJapaneseModel(Buffer.from('<html>')), /Invalid/);
  const bad = fakeModel(); bad.writeBigInt64LE(9999999n, 4);
  assert.throws(() => validateJapaneseModel(bad), /Truncated/);
});
