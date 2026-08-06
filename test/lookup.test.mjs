// Exercises the real lookup path -- the same dict-store.js, card.js and pinyin.js the
// extension ships -- against the built shards, with `chrome` and `fetch` stubbed to read
// from disk. Everything except the DOM hit-testing is covered here; run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDictStub } from './dict-stub.mjs';

installDictStub();

const { lookupCandidates } = await import('../extension/src/lib/dict-store.js');
const { buildCard } = await import('../extension/src/lib/card.js');
const { toDiacritics } = await import('../extension/src/lib/pinyin.js');

test('candidates come back longest-first, one per matching length', async () => {
  const matches = await lookupCandidates('中国菜很好吃');
  assert.deepEqual(
    matches.map((m) => m.headword),
    ['中国菜', '中国', '中'],
  );
  assert.deepEqual(
    matches.map((m) => m.length),
    [3, 2, 1],
  );
});

test('lengths with no dictionary entry are skipped entirely', async () => {
  // 中华人民共和国 is an entry, but 中华人民 and 中华人 are not.
  const headwords = (await lookupCandidates('中华人民共和国万岁')).map((m) => m.headword);
  assert.ok(headwords.includes('中华人民共和国'));
  assert.ok(!headwords.includes('中华人民'));
  assert.deepEqual(headwords, [...headwords].sort((a, b) => b.length - a.length));
});

test('traditional headwords resolve and carry their simplified form', async () => {
  const [match] = await lookupCandidates('中國');
  assert.equal(match.headword, '中國');
  const card = buildCard(match.headword, match.entries[0]);
  assert.equal(card.simplified, '中国');
  assert.equal(card.traditional, '中國');
  assert.ok(card.hasVariants);
});

test('a card carries both pinyin forms, senses and context', async () => {
  const [match] = await lookupCandidates('你好');
  const card = buildCard(match.headword, match.entries[0], {
    sentence: '你好世界。',
    url: 'https://example.com/',
    title: 'Example',
  });

  assert.equal(card.pinyin, 'nǐ hǎo');
  assert.equal(card.pinyinNumbered, 'ni3 hao3');
  assert.deepEqual(card.syllables.map((s) => s.tone), [3, 3]);
  assert.ok(card.senses.length >= 1);
  assert.equal(card.sentence, '你好世界。');
  assert.equal(card.sourceUrl, 'https://example.com/');
});

test('entries with several readings are all returned', async () => {
  const [match] = await lookupCandidates('中');
  const cards = match.entries.map((row) => buildCard('中', row));
  // 中 is at least zhōng and zhòng.
  assert.ok(cards.length > 1);
  assert.ok(cards.some((c) => c.pinyinNumbered.toLowerCase() === 'zhong1'));
  assert.ok(cards.some((c) => c.pinyinNumbered.toLowerCase() === 'zhong4'));
});

test('numbered pinyin embedded in glosses is rendered with tone marks', async () => {
  const [match] = await lookupCandidates('打');
  const senses = match.entries.flatMap((row) => buildCard('打', row).senses);
  const crossReference = senses.find((s) => s.includes('打伞'));

  assert.ok(crossReference, 'expected the 打伞 cross-reference sense');
  assert.ok(crossReference.includes('dǎ sǎn'), crossReference);
  assert.ok(!/\[da3 san3\]/.test(crossReference), 'raw tone digits should be gone');
});

test('bracketed text that is not pinyin is left alone', async () => {
  const { buildCard: build } = await import('../extension/src/lib/card.js');
  const card = build('X', ['X', '', 'xi1', 'see also [some note]/a [2] footnote/abbr. for AB[C]']);
  assert.deepEqual(card.senses, ['see also [some note]', 'a [2] footnote', 'abbr. for AB[C]']);
});

test('non-Chinese and empty input yield nothing', async () => {
  assert.deepEqual(await lookupCandidates(''), []);
  assert.deepEqual(await lookupCandidates('hello'), []);
});

test('tone marks land on the correct vowel', () => {
  const cases = [
    ['ni3 hao3', 'nǐ hǎo'],
    ['gou3', 'gǒu'], // "ou" -> the o takes it
    ['jiu3', 'jiǔ'], // "iu" -> the last vowel
    ['xie4', 'xiè'], // e wins over i
    ['lu:4', 'lǜ'], // u: is ü
    ['nu:3 hai2', 'nǚ hái'],
    ['ma5', 'ma'], // neutral tone is unmarked
    ['Zhong1 wen2', 'Zhōng wén'],
    ['CD ji1', 'CD jī'], // latin tokens pass through
  ];
  for (const [input, expected] of cases) {
    assert.equal(toDiacritics(input).text, expected, input);
  }
});
