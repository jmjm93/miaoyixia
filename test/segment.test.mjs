// Where the word boundaries go.
//
// Two halves. The first drives segment() against a made-up dictionary, so the algorithm is
// pinned without depending on what CC-CEDICT happens to contain. The second runs the real
// shards, because the bug that prompted all this was a real sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segment } from '../extension/src/lib/segment.js';
import { installDictStub, readingFor } from './dict-stub.mjs';

installDictStub();

/** Segment `text` knowing only `words`, and return the pieces as strings. */
function split(text, words) {
  const chars = [...text];
  const dictionary = new Set(words);
  const wordLengthsAt = chars.map((_, start) => {
    const lengths = [];
    for (let length = 1; start + length <= chars.length; length++) {
      if (dictionary.has(chars.slice(start, start + length).join(''))) lengths.push(length);
    }
    return lengths;
  });

  return segment(chars.length, wordLengthsAt).map(({ start, length }) =>
    chars.slice(start, start + length).join(''),
  );
}

test('a line of two words is split between them', () => {
  // The reported bug: a lookup answered for 开始 and ignored everything after it, because it
  // only ever matched from position 0.
  assert.deepEqual(split('开始阅读', ['开始', '阅读', '开', '始', '阅', '读']), ['开始', '阅读']);
});

test('a greedy first choice does not get to strand the rest of the line', () => {
  // The case maximum matching gets wrong. 研究生 is a real word ("graduate student"), so greedy
  // takes it and leaves 命 stranded; the whole-line cost says otherwise.
  const words = ['研究', '研究生', '生命', '起源', '生', '命'];
  const result = split('研究生命起源', words);

  assert.deepEqual(result, ['研究', '生命', '起源']);
  assert.notDeepEqual(result, ['研究生', '命', '起源'], 'this is the greedy answer');
});

test('the tie is broken against leaving single characters alone', () => {
  // Both readings above are three tokens, so counting alone cannot separate them. What decides
  // it is that the greedy one orphans a character.
  const words = ['研究', '研究生', '生命', '起源', '生', '命'];
  assert.deepEqual(split('研究生命起源', words), ['研究', '生命', '起源']);
});

test('characters the dictionary has never heard of become their own token', () => {
  // Punctuation, latin, and whatever OCR invents. They must not drag a neighbour into a worse
  // split, and they must not make the line unsegmentable.
  assert.deepEqual(split('开始!阅读', ['开始', '阅读']), ['开始', '!', '阅读']);
  assert.deepEqual(split('???', []), ['?', '?', '?']);
});

test('a longer word wins a tie against several shorter ones', () => {
  assert.deepEqual(split('中国菜', ['中国菜', '中国', '菜', '中']), ['中国菜']);
});

test('an empty line segments to nothing rather than throwing', () => {
  assert.deepEqual(split('', ['开始']), []);
  assert.deepEqual(segment(0, []), []);
});

test('every token is contiguous and the tokens cover the whole line', () => {
  // Whatever it decides, it may not drop or duplicate a character -- the tokens are what the
  // window renders as the recognised line, and a gap there would misreport what was read.
  const text = '我喜欢吃中国菜开始阅读';
  const pieces = split(text, ['我', '喜欢', '吃', '中国菜', '中国', '开始', '阅读', '菜']);
  assert.equal(pieces.join(''), text);
});

test('the real dictionary splits the sentence that started this', async () => {
  const tokens = await readingFor('开始阅读');
  assert.deepEqual(
    tokens.map((token) => token.text),
    ['开始', '阅读'],
  );

  // Both words are looked up, not just the first -- which is the whole point.
  for (const token of tokens) {
    assert.ok(token.candidates.length > 0, `${token.text} has no candidates`);
    assert.equal(token.candidates[0].headword, token.text);
    assert.ok(token.candidates[0].cards[0].senses.length > 0, `${token.text} has no senses`);
  }
});

test('each token carries the other lengths at its position, so a bad split is recoverable', async () => {
  // 中国菜 also matches 中国 and 中 at the same position. Keeping them is what lets the window
  // offer candidate tabs rather than making the user re-snip.
  const [token] = await readingFor('中国菜');
  const headwords = token.candidates.map((candidate) => candidate.headword);

  assert.equal(token.text, '中国菜');
  assert.ok(headwords.includes('中国'), `expected a shorter candidate, got ${headwords.join(', ')}`);
  // Longest first, the same order the popup's tabs use.
  assert.deepEqual(headwords, [...headwords].sort((a, b) => b.length - a.length));
});
