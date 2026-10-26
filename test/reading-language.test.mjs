import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageEvidence, dictionaryCoverage } from '../extension/src/lib/reading-language.js';

test('sentence clues distinguish languages without guessing shared Han words', () => {
  for (const text of ['学生です。', '私は学校に行きます', 'コーヒー']) assert.equal(languageEvidence(text), 'ja');
  for (const text of ['这是学校。', '他是学生。', '我喜欢我的学校。']) assert.equal(languageEvidence(text), 'zh');
  for (const text of ['学生', '日本', '学校', '']) assert.equal(languageEvidence(text), null);
  assert.equal(languageEvidence('这是「ありがとう」的意思。'), 'zh');
});

test('dictionary evidence measures non-overlapping coverage and ignores shared single characters', () => {
  assert.equal(dictionaryCoverage('学校生活', [[{ length: 2 }], [{ length: 1 }], [{ length: 2 }], []]), 1);
  assert.equal(dictionaryCoverage('学校生活', [[{ length: 3 }], [{ length: 3 }], [], []]), 0.75);
  assert.equal(dictionaryCoverage('日本', [[{ length: 1 }], [{ length: 1 }]]), 0);
  assert.equal(dictionaryCoverage('', []), 0);
});
