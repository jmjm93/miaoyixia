import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('Japanese speech selects a Japanese OS voice without falling back to Mandarin', () => {
  const sandbox = {};
  runInNewContext(readFileSync(new URL('../extension/src/content/speech.js', import.meta.url), 'utf8'), sandbox);
  const pick = sandbox.zhDic.speech.pickVoice;
  const chinese = { lang: 'zh-CN', name: 'Mandarin' };
  const japanese = { lang: 'ja-JP', name: 'Japanese' };
  assert.equal(pick([chinese, japanese], 'ja'), japanese);
  assert.equal(pick([chinese], 'ja'), null);
  assert.equal(pick([japanese, chinese]), chinese);
});
