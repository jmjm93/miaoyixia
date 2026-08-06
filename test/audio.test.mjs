// Tests the Commons recording matcher. This is the component where a bug is actively
// harmful rather than merely unhelpful: `intitle:` matches substrings, so a search for 中国
// legitimately returns 中国功夫, and playing that would teach the wrong word.
//
// The search itself is exercised against recorded API responses -- real fixtures captured
// from commons.wikimedia.org -- so the suite neither needs the network nor risks the rate
// limiting that Wikimedia applies to bursts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileUrl, matchesWord, searchRecordings, spokenTextOf } from '../extension/src/lib/audio-source.js';

test('extracts the spoken word from Lingua Libre filenames', () => {
  assert.equal(spokenTextOf('LL-Q9192 (cmn)-Luilui6666-你好.wav'), '你好');
  assert.equal(spokenTextOf('File:LL-Q9192 (cmn)-Bakerkobe-你好.wav'), '你好');
  // Speaker names containing a space must not confuse the split.
  assert.equal(spokenTextOf('LL-Q9192 (cmn)-Fake estate-热门.wav'), '热门');
  assert.equal(spokenTextOf('LL-Q727694 (cmn)-Shangkuanlc-学习.wav'), '学习');
});

test('extracts the spoken word from legacy Zh- filenames', () => {
  assert.equal(spokenTextOf('Zh-你好.ogg'), '你好');
  assert.equal(spokenTextOf('Zh nǐ hǎo.ogg'), 'nǐ hǎo');
  assert.equal(spokenTextOf('zh-hǎo.ogg'), 'hǎo');
  assert.equal(spokenTextOf('Zh-tw-好警察壞狗狗.ogg'), '好警察壞狗狗');
});

test('ignores filenames that follow no known convention', () => {
  assert.equal(spokenTextOf('Open book 01.svg'), '');
  assert.equal(spokenTextOf('Wikipedia-logo-v2.svg'), '');
});

test('accepts an exact Mandarin match', () => {
  assert.ok(matchesWord('LL-Q9192 (cmn)-Luilui6666-谢谢.wav', '谢谢'));
  assert.ok(matchesWord('Zh-你好.ogg', '你好'));
  assert.ok(matchesWord('LL-Q727694 (cmn)-Shangkuanlc-学习.wav', '学习'), 'Taiwanese Mandarin counts');
});

test('rejects a substring match, however plausible', () => {
  // Every one of these is a real Commons file returned by a search for the shorter word.
  assert.ok(!matchesWord('Zh 中国功夫.ogg', '中国'), 'Chinese kung fu is not 中国');
  assert.ok(!matchesWord('Zh-奥司他韦.ogg', '他'), 'oseltamivir is not 他');
  assert.ok(!matchesWord('Zh-微软小娜.ogg', '小'), 'Cortana is not 小');
  assert.ok(!matchesWord('LL-Q9192 (cmn)-Luilui6666-打嘴巴.wav', '打'));
  assert.ok(!matchesWord('LL-Q9192 (cmn)-Luilui6666-对话A、你你喜欢做什麽运动?.wav', '你'));
});

test('rejects other Chinese languages sharing the same characters', () => {
  assert.ok(!matchesWord('zh-yue-你好.opus', '你好'), 'Cantonese');
  assert.ok(!matchesWord('LL-Q9186 (yue)-Luilui6666-中国.wav', '中国'), 'Cantonese by Q-id');
  assert.ok(!matchesWord('LL-Q9186-Luilui6666-中国.wav', '中国'), 'Cantonese, no lang tag');
  assert.ok(!matchesWord('Ja-Chugoku.ogg', '中国'), 'Japanese reading of the same characters');
});

test('rejects non-audio files', () => {
  assert.ok(!matchesWord('打-seal.svg', '打'));
  assert.ok(!matchesWord('打-bw.png', '打'));
});

test('matches a pinyin-named file against the reading, not just the characters', () => {
  // Legacy contributors often named files in pinyin; matching it widens coverage.
  assert.ok(matchesWord('Zh nǐ hǎo.ogg', '你好', 'nǐ hǎo'));
  assert.ok(matchesWord('zh-hǎo.ogg', '好', 'hǎo'));
  // Case and spacing vary between contributors.
  assert.ok(matchesWord('Zh-Nǐ  Hǎo.ogg', '你好', 'nǐ hǎo'));
  // And it stays reading-specific: dǎ's recording is not dá's.
  assert.ok(matchesWord('Zh-dǎ.ogg', '打', 'dǎ'));
  assert.ok(!matchesWord('Zh-dǎ.ogg', '打', 'dá'));
});

test('picks exact matches out of a real search response, Lingua Libre first', async () => {
  // Captured from commons.wikimedia.org for `intitle:中国 filetype:audio`.
  const response = {
    query: {
      search: [
        { title: 'File:Zh 中国功夫.ogg' },
        { title: 'File:LL-Q9186 (yue)-Luilui6666-中国.wav' },
        { title: 'File:Zh-中国.ogg' },
        { title: 'File:LL-Q9192 (cmn)-Jouketou-中国.wav' },
        { title: 'File:Ja-Chugoku.ogg' },
      ],
    },
  };

  const names = await searchRecordings('中国', 'Zhōng guó', async () => response);
  assert.deepEqual(names, ['LL-Q9192 (cmn)-Jouketou-中国.wav', 'Zh-中国.ogg']);
});

test('returns nothing when a search has only near misses', async () => {
  const response = { query: { search: [{ title: 'File:Zh 中国功夫.ogg' }, { title: 'File:Ja-Chugoku.ogg' }] } };
  assert.deepEqual(await searchRecordings('中国', '', async () => response), []);
});

test('survives an empty or malformed search response', async () => {
  assert.deepEqual(await searchRecordings('你好', '', async () => ({})), []);
  assert.deepEqual(await searchRecordings('你好', '', async () => ({ query: { search: [] } })), []);
});

test('builds a file URL that does not need a second API call', () => {
  const url = fileUrl('LL-Q9192 (cmn)-Luilui6666-谢谢.wav');
  assert.ok(url.startsWith('https://commons.wikimedia.org/wiki/Special:FilePath/'));
  // Spaces become underscores, as MediaWiki titles require, and nothing is left unescaped
  // that would break the URL. Parentheses are legal unencoded and encodeURIComponent keeps
  // them, which MediaWiki accepts.
  assert.ok(url.includes('LL-Q9192_(cmn)-Luilui6666'), url);
  assert.ok(!url.includes(' '));
  assert.ok(url.includes('%E8%B0%A2%E8%B0%A2.wav'), 'the CJK is percent-encoded');
});
