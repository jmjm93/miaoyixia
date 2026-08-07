// The downloaded gloss layer: how a translated dictionary is turned into shards, and how a
// packed English row finds its translation again.
//
// The interesting failure here is not "no translation found" -- that is a normal outcome the
// runtime handles by showing English. It is finding the *wrong* translation, which no user
// could detect: the popup would confidently show a real Spanish definition belonging to a
// different word. So the key tests below are about identity, not coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { glossKey, shardGlosses } from '../extension/src/lib/gloss-store.js';
import { SHARD_COUNT, shardFor } from '../extension/src/lib/shard.js';

const FIXTURE = [
  '#! entries=4',
  '# a comment',
  '你好 你好 [ni3 hao3] /hola/',
  '東西 东西 [dong1 xi1] /este y oeste/',
  '東西 东西 [dong1 xi5] /cosa/objeto/CL:個|个[ge4]/',
  '打 打 [da2] /(préstamo) docena/',
].join('\n');

test('shards by head character, under both scripts', () => {
  const { shards, entries } = shardGlosses(FIXTURE);
  assert.equal(entries, 4);

  // 東西/东西 differ, so the entry must be reachable from either script's shard.
  const simplified = shards[shardFor('东')];
  const traditional = shards[shardFor('東')];
  const key = glossKey('東西', '东西', 'dong1 xi5');
  assert.equal(simplified[key], 'cosa/objeto/CL:個|个[ge4]');
  assert.equal(traditional[key], 'cosa/objeto/CL:個|个[ge4]');
});

test('readings of the same headword stay separate', () => {
  const { shards } = shardGlosses(FIXTURE);
  const shard = shards[shardFor('东')];
  assert.equal(shard[glossKey('東西', '东西', 'dong1 xi1')], 'este y oeste');
  assert.equal(shard[glossKey('東西', '东西', 'dong1 xi5')], 'cosa/objeto/CL:個|个[ge4]');
});

test('entries sharing simplified+pinyin are not conflated', () => {
  // Real CC-CEDICT shape: 1,234 pairs differ only in their traditional form. Keying on
  // simplified+pinyin would map one entry's glosses onto the other's senses.
  const { shards } = shardGlosses(
    ['㕥 以 [yi3] /antigua variante de 以[yi3]/', '㠯 以 [yi3] /otra cosa/'].join('\n'),
  );
  const shard = shards[shardFor('以')];
  assert.equal(shard[glossKey('㕥', '以', 'yi3')], 'antigua variante de 以[yi3]');
  assert.equal(shard[glossKey('㠯', '以', 'yi3')], 'otra cosa');
});

test('an entry whose scripts match is stored once, under one key', () => {
  const { shards } = shardGlosses('你好 你好 [ni3 hao3] /hola/');
  const shard = shards[shardFor('你')];
  assert.deepEqual(Object.keys(shard), [glossKey('你好', '你好', 'ni3 hao3')]);
});

test('glossKey treats an empty traditional as "same as simplified"', () => {
  // Packed rows store '' when the two scripts agree, so the runtime must normalise it back
  // or every such lookup silently misses.
  assert.equal(glossKey('', '你好', 'ni3 hao3'), glossKey('你好', '你好', 'ni3 hao3'));
});

test('a packed row resolves through the same shard as its headword', () => {
  const { shards } = shardGlosses(FIXTURE);
  // Exactly what dict-store hands the runtime: [simplified, traditional|'', pinyin, senses].
  const row = ['东西', '東西', 'dong1 xi5', 'thing/stuff'];
  for (const headword of ['东西', '東西']) {
    const shard = shards[shardFor(headword)];
    assert.equal(shard[glossKey(row[1], row[0], row[2])], 'cosa/objeto/CL:個|个[ge4]');
  }
});

test('non-dictionary input yields nothing rather than garbage', () => {
  // A moved file on a raw-content host answers 200 with an HTML error page. Storing that
  // would fill IndexedDB with markup and quietly disable the feature.
  for (const junk of ['<!DOCTYPE html><title>404</title>', '', '#! entries=0', 'not a dictionary']) {
    assert.equal(shardGlosses(junk).entries, 0, `should reject: ${junk.slice(0, 24)}`);
  }
});

test('every shard index is in range', () => {
  const { shards } = shardGlosses(FIXTURE);
  assert.equal(shards.length, SHARD_COUNT);
  for (const headword of ['你好', '东西', '東西', '打']) {
    const index = shardFor(headword);
    assert.ok(Number.isInteger(index) && index >= 0 && index < SHARD_COUNT);
  }
});
