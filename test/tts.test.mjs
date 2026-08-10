// Tests the synthesised-pronunciation fallback.
//
// This exists because Commons coverage is thin: measured against the matcher in audio-source.js,
// ~80% of the 25 most frequent words have a recording but only ~12% by rank 2000, and a
// traditional-only headword such as 於 has none in either script. What matters here is that a
// failing endpoint can never write a broken file into someone's collection, since both services
// answer a rejected request with a 200 and an HTML error page rather than an error status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTS_SERVICES, baiduSpeed, refererFor, synthesise, ttsUrl } from '../extension/src/lib/tts-source.js';

/** A response that looks like real MP3 bytes: big enough to pass the too-small guard. */
function mp3Response(bytes = 4096, headers = { 'content-type': 'audio/mpeg' }) {
  return {
    ok: true,
    headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  };
}

test('builds a Google URL that needs no signing token', () => {
  const url = ttsUrl('google', '你好');
  assert.ok(url.startsWith('https://translate.google.com/translate_tts?'), url);
  // client=tw-ob is the whole reason this endpoint is usable without gTTS's RPC dance.
  assert.ok(url.includes('client=tw-ob'), url);
  assert.ok(url.includes('tl=zh-CN'), url);
  assert.ok(url.includes('q=%E4%BD%A0%E5%A5%BD'), 'the word is percent-encoded');
  assert.ok(url.includes('textlen=2'), 'length counts characters, not UTF-8 bytes');
});

test('builds a Baidu URL matching the one Chinese Support 3 uses', () => {
  const url = ttsUrl('baidu', '你好');
  assert.ok(url.startsWith('https://fanyi.baidu.com/gettts?'), url);
  assert.ok(url.includes('lan=zh'), url);
  assert.ok(url.includes('source=web'), url);
  assert.ok(url.includes('text=%E4%BD%A0%E5%A5%BD'), url);
});

test('an unknown service yields no URL rather than a broken one', () => {
  assert.equal(ttsUrl('polly', '你好'), '');
  assert.equal(ttsUrl('off', '你好'), '');
});

test('maps the playback rate onto Baidu 1-9 scale', () => {
  assert.equal(baiduSpeed(1), 5, 'normal speed is the middle of the scale');
  assert.ok(baiduSpeed(0.5) < baiduSpeed(1), 'slower is a lower number');
  assert.ok(baiduSpeed(1.2) > baiduSpeed(1), 'faster is a higher number');
  // Out-of-range input is clamped rather than sent on to be rejected.
  for (const rate of [-5, 0, 99, NaN]) {
    const speed = baiduSpeed(rate);
    assert.ok(speed >= 1 && speed <= 9, `${rate} produced ${speed}`);
  }
});

test('returns the bytes and a filename extension for the collection', async () => {
  const audio = await synthesise('你好', { service: 'google', fetchImpl: async () => mp3Response() });
  assert.equal(audio.extension, '.mp3');
  assert.equal(audio.mime, 'audio/mpeg');
  assert.equal(audio.service, 'google');
  assert.equal(audio.data.byteLength, 4096);
});

test('rejects a response too small to be speech', async () => {
  // Both endpoints answer a request they dislike with 200 and a short HTML body. Writing that
  // to the collection would give a note an unplayable attachment, which is worse than none.
  await assert.rejects(
    () => synthesise('你好', { service: 'google', fetchImpl: async () => mp3Response(80) }),
    /80 bytes/,
  );
});

test('rejects an error status', async () => {
  const failing = async () => ({ ok: false, status: 429, headers: { get: () => null } });
  await assert.rejects(() => synthesise('你好', { service: 'baidu', fetchImpl: failing }), /429/);
});

test('declines empty input and text too long to be a word', async () => {
  let called = false;
  const spy = async () => { called = true; return mp3Response(); };

  assert.equal(await synthesise('', { service: 'google', fetchImpl: spy }), null);
  assert.equal(await synthesise('   ', { service: 'google', fetchImpl: spy }), null);
  assert.equal(await synthesise('好'.repeat(300), { service: 'google', fetchImpl: spy }), null);
  assert.equal(called, false, 'nothing should reach the network');
});

test('declines a service it does not implement instead of fetching', async () => {
  let called = false;
  const spy = async () => { called = true; return mp3Response(); };
  assert.equal(await synthesise('你好', { service: 'off', fetchImpl: spy }), null);
  assert.equal(called, false);
});

test('sends each host its own referrer', async () => {
  // Verified against the live services: Baidu answers a request carrying Google's referrer
  // with a 200 and a zero-length body, which would have made the fallback look broken while
  // reporting success.
  assert.match(refererFor('google').Referer, /translate\.google\.com/);
  assert.match(refererFor('baidu').Referer, /fanyi\.baidu\.com/);
  assert.deepEqual(refererFor('off'), {});

  const seen = [];
  const spy = async (_url, init) => { seen.push(init.headers.Referer); return mp3Response(); };
  await synthesise('好', { service: 'google', fetchImpl: spy });
  await synthesise('好', { service: 'baidu', fetchImpl: spy });
  assert.notEqual(seen[0], seen[1], 'the two services must not share a referrer');
});

test('every advertised service actually builds a URL and has a referrer', () => {
  for (const service of TTS_SERVICES) {
    assert.ok(refererFor(service).Referer, `${service} has no referrer`);
  }
});

test('every advertised service actually builds a URL', () => {
  for (const service of TTS_SERVICES) {
    assert.ok(ttsUrl(service, '好'), `${service} builds no URL`);
  }
});
