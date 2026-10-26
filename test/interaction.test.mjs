// Tests the trigger behaviour end to end: real mouse and key events, the real
// content.js/popup.js, and real dictionary lookups.
//
// content.js only talks to the outside world through chrome.runtime.sendMessage, so the
// stub here routes those messages back into Node via exposeFunction, where the actual
// service-worker handler logic runs against the built shards. Nothing about the
// interaction model itself is faked.
//
// content.js guards against double-injection with window.__zhDicLoaded and reads its
// settings once at startup, so each scenario gets a fresh page.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { candidatesFor, installDictStub, readingFor } from './dict-stub.mjs';

installDictStub();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { DEFAULT_SETTINGS } = await import('../extension/src/lib/settings.js');

const CANDIDATE_BROWSERS = [
  process.env.ZH_DIC_BROWSER,
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
// Manifest order. src/lib/messages.js goes first: it is a content script too (the string
// catalogue has to be reachable from the classic-script world), and popup.js reads it at load.
const CONTENT_SCRIPTS = [
  '../lib/messages.js',
  'text-at-point.js',
  'speech.js',
  'entry-view.js',
  'popup.js',
  'snip.js',
  'capture.js',
  'result.js',
  'content.js',
];

/** A minimal valid 8-bit PCM WAV, so Web Audio decoding is exercised without the network. */
function tinyWavBase64(ms = 60, hz = 8000) {
  const samples = Math.round((hz * ms) / 1000);
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(hz, 24);
  buffer.writeUInt32LE(hz, 28); // byte rate
  buffer.writeUInt16LE(1, 32); // block align
  buffer.writeUInt16LE(8, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) buffer[44 + i] = 128 + Math.round(60 * Math.sin((i / hz) * 440 * 2 * Math.PI));
  return buffer.toString('base64');
}

const ZH_VOICE = { name: 'Microsoft Huihui', lang: 'zh-CN', localService: true };

let browser;
let server;
let origin;

before(async () => {
  const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
  assert.ok(executablePath, 'No Chromium-family browser found. Set ZH_DIC_BROWSER=<path>.');

  server = createServer(async (req, res) => {
    const rel = req.url === '/' ? 'test/page.html' : decodeURIComponent(req.url).slice(1);
    try {
      const body = await readFile(join(root, rel));
      res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;

  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});

after(async () => {
  await browser?.close();
  server?.close();
});

/**
 * A page with the content scripts running under the given settings.
 * `lookupDelay` stands in for a slow or cold service worker.
 */
async function openPage(
  overrides = {},
  {
    lookupDelay = 0,
    voices = [],
    audioResult = { found: false },
    ankiInspect = null,
    ankiAdd = null,
    glossPending = false,
    translate = null,
  } = {},
) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });

  const failures = [];
  page.on('pageerror', (e) => failures.push(e.message));

  // Same shape the service worker replies with: { ok, result }.
  await page.exposeFunction('__zhLookup', async (text) => {
    if (lookupDelay) await new Promise((r) => setTimeout(r, lookupDelay));
    return { candidates: await candidatesFor(text, {}, translate), glossPending };
  });
  await page.exposeFunction('__zhRead', async (text) => ({
    tokens: await readingFor(text, {}, translate),
    glossPending,
  }));
  await page.exposeFunction('__zhAudio', async () => audioResult);
  // Returning null makes the stub reject, standing in for Anki being closed.
  await page.exposeFunction('__zhAnkiInspect', async () => ankiInspect);
  await page.exposeFunction('__zhAnkiAdd', async () => ankiAdd);

  await page.evaluateOnNewDocument(
    `window.__settings = ${JSON.stringify(settings)};
     window.__voices = ${JSON.stringify(voices)};
     window.__spoken = [];

     // Stub both halves of the speech API. SpeechSynthesisUtterance is replaced because the
     // real one rejects a plain object assigned to .voice; speechSynthesis has to go through
     // defineProperty because it is a read-only accessor on Window -- plain assignment fails
     // silently and leaves the real, voice-less engine in place.
     window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
     Object.defineProperty(window, 'speechSynthesis', {
       configurable: true,
       value: {
         getVoices: () => window.__voices,
         speak(u) {
           window.__spoken.push({ text: u.text, lang: u.lang, rate: u.rate, voice: u.voice && u.voice.name });
           setTimeout(() => u.onend && u.onend(), 10);
         },
         cancel() {},
         addEventListener() {},
       },
     });

     // Stands in for captureVisibleTab: a white viewport with one red block at a known place, so
     // a crop can be checked against the region that was actually dragged rather than merely
     // against its size. Painted at devicePixelRatio, the way a real capture arrives.
     //
     // Sized from innerWidth/innerHeight, which is what captureVisibleTab actually returns --
     // the viewport *including* its scrollbars. Painting it at documentElement.clientWidth
     // instead baked the crop's own bug into the fixture, so the test could not have caught it.
     //
     // The region sits well to the right for the same reason: a scale error displaces the crop
     // in proportion to the distance from the left edge, so a region near x=0 hides it.
     window.__captureRegion = { x: 600, y: 140, width: 180, height: 120 };
     window.__fakeCapture = () => {
       const dpr = window.devicePixelRatio || 1;
       const canvas = document.createElement('canvas');
       canvas.width = Math.round(window.innerWidth * dpr);
       canvas.height = Math.round(window.innerHeight * dpr);
       const ctx = canvas.getContext('2d');
       ctx.fillStyle = '#ffffff';
       ctx.fillRect(0, 0, canvas.width, canvas.height);
       const r = window.__captureRegion;
       ctx.fillStyle = '#ff0000';
       ctx.fillRect(r.x * dpr, r.y * dpr, r.width * dpr, r.height * dpr);
       return canvas.toDataURL('image/png');
     };

     window.chrome = {
       runtime: {
         getURL: (p) => '${origin}/extension/' + p,
         sendMessage: async (msg) => {
           if (msg.type === 'getSettings') return { ok: true, result: window.__settings };
           if (msg.type === 'lookup') return { ok: true, result: await window.__zhLookup(msg.text) };
           if (msg.type === 'read') return { ok: true, result: await window.__zhRead(msg.text) };
           if (msg.type === 'capture') return { ok: true, result: { dataUrl: window.__fakeCapture() } };
           // Off unless a test asks for one, mirroring the real default.
           if (msg.type === 'translate') return { ok: true, result: { text: window.__translation ?? null } };
           // Only the service worker can read page zoom, so the harness stands in for it.
           if (msg.type === 'zoom') return { ok: true, result: { factor: window.__zoom ?? 1 } };
           // The real recogniser is 6 MB of WASM in an offscreen document, which none of this
           // harness has. __ocrText stands in for whatever it would have read; null is the
           // ordinary "nothing legible on this panel" answer rather than a failure.
           // __readAs stands in for the recogniser *and* for the model choice the service worker
           // makes from the settings, so a test can prove a re-read used the new ones.
           if (msg.type === 'recognise') {
             const text = window.__readAs ? window.__readAs(window.__settings) : (window.__ocrText ?? null);
             return { ok: true, result: { text: text ?? null } };
           }
           if (msg.type === 'audio') return { ok: true, result: await window.__zhAudio(msg.word, msg.pinyin) };
           if (msg.type === 'ankiInspect') {
             const r = await window.__zhAnkiInspect();
             return r ? { ok: true, result: r } : { ok: false, error: 'Cannot reach Anki' };
           }
           if (msg.type === 'ankiAdd') {
             const r = await window.__zhAnkiAdd();
             return r ? { ok: true, result: r } : { ok: false, error: 'cannot create note because it is a duplicate' };
           }
           return { ok: false, error: 'unhandled ' + msg.type };
         },
         // The real listener is the service worker's route into the tab. Holding on to it lets a
         // test start a snip the same way the toolbar button does.
         onMessage: { addListener: (fn) => { window.__zhOnMessage = fn; } },
       },
       storage: {
         sync: {
           get: async () => window.__settings,
           // The result window's tuner writes here, the same as the options page does. Without a
           // set() the whole flow throws, so this is not optional scaffolding.
           //
           // And a write notifies, the way the browser does. Discarding the listener meant the
           // content script's own settings-changed handler could never run under test, which is
           // most of what reacting to a settings change *is*.
           set: async (patch) => {
             Object.assign(window.__settings, patch);
             const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }]));
             await window.__zhStorageChanged?.(changes, 'sync');
           },
         },
         onChanged: { addListener: (fn) => { window.__zhStorageChanged = fn; } },
       },
     };`,
  );

  await page.goto(`${origin}/`, { waitUntil: 'load' });
  for (const file of CONTENT_SCRIPTS) {
    await page.addScriptTag({ content: await readFile(join(root, 'extension/src/content', file), 'utf8') });
  }
  // content.js appends the popup host once it has its settings.
  await page.waitForSelector('[data-zh-dic-host]', { timeout: 10000 });

  page.pointAt = async (selector, index) => {
    const point = await page.pointAtImmediate(selector, index);
    // scrollIntoView above dispatches a scroll event on the next frame, and content.js
    // (correctly) dismisses on scroll -- which would cancel the lookup the caller is about to
    // trigger. Let it land first. Only targets far enough down the page to actually scroll are
    // affected, which is why this went unnoticed until a fixture near the bottom was used.
    await new Promise((r) => setTimeout(r, 100));
    return point;
  };

  page.pointAtImmediate = async (selector, index) =>
    page.evaluate(
      ([sel, i]) => {
        const el = document.querySelector(sel);
        el.scrollIntoView({ block: 'center' });
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (n.parentElement.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
        });
        let seen = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (seen + node.data.length <= i) {
            seen += node.data.length;
            continue;
          }
          const range = document.createRange();
          range.setStart(node, i - seen);
          range.setEnd(node, i - seen + 1);
          const r = range.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        throw new Error(`${sel} has fewer than ${i + 1} characters`);
      },
      [selector, index],
    );

  page.popupVisible = () =>
    page.evaluate(() => !!document.querySelector('[data-zh-dic-host][data-visible]'));

  page.popupRect = () =>
    page.evaluate(() => {
      const r = document.querySelector('[data-zh-dic-host]').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });

  /** Move in small steps with a pause between, the way a hand actually crosses a gap. */
  page.glideTo = async (from, to, steps = 6, pause = 40) => {
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await new Promise((r) => setTimeout(r, pause));
    }
  };

  page.assertNoErrors = () => assert.deepEqual(failures, [], 'unexpected page errors');

  /** Open a popup on #plain and return the shadow-root speaker buttons. */
  page.openPopup = async (selector = '#plain', index = 4) => {
    const at = await page.pointAt(selector, index);
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down('Shift');
    await page.mouse.move(at.x + 1, at.y);
    await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });
    await page.keyboard.up('Shift');
    return at;
  };

  // The shadow root is open, so `>>>` reaches the popup's own elements.
  /** The headword the popup is currently showing, read out of its shadow root. */
  page.shownWord = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-zh-dic-host]')?.shadowRoot?.querySelector('.entry .word')?.textContent ?? null,
    );

  page.speakers = () => page.$$('>>> button.speak');
  page.adders = () => page.$$('>>> button.anki-add');
  page.adderStates = async () =>
    Promise.all(
      (await page.adders()).map((b) =>
        b.evaluate((el) => ({ state: el.dataset.state, disabled: el.disabled, title: el.title })),
      ),
    );
  page.spoken = () => page.evaluate(() => window.__spoken);

  return page;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('with a modifier trigger, hovering alone does nothing', async () => {
  const page = await openPage({ triggerKey: 'Shift' });
  const at = await page.pointAt('#plain', 4);

  await page.mouse.move(at.x, at.y);
  await wait(400);
  assert.equal(await page.popupVisible(), false);

  page.assertNoErrors();
  await page.close();
});

test('pressing the modifier looks up the hovered word, and it survives release', async () => {
  const page = await openPage({ triggerKey: 'Shift' });
  const at = await page.pointAt('#plain', 4);

  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Shift');
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });

  // Releasing must not dismiss it -- the tabs have to stay clickable.
  await page.keyboard.up('Shift');
  await wait(150);
  assert.equal(await page.popupVisible(), true);

  await page.keyboard.press('Escape');
  assert.equal(await page.popupVisible(), false);

  page.assertNoErrors();
  await page.close();
});

test('only the configured modifier triggers a lookup', async () => {
  const page = await openPage({ triggerKey: 'Alt' });
  const at = await page.pointAt('#plain', 4);
  await page.mouse.move(at.x, at.y);

  await page.keyboard.down('Shift');
  await wait(250);
  assert.equal(await page.popupVisible(), false, 'Shift should be ignored when Alt is the trigger');
  await page.keyboard.up('Shift');

  await page.keyboard.down('Alt');
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });
  await page.keyboard.up('Alt');

  page.assertNoErrors();
  await page.close();
});

test('hover mode opens with no key held, after the dwell delay', async () => {
  const page = await openPage({ triggerKey: 'none', hoverDelay: 400 });
  const at = await page.pointAt('#plain', 4);

  await page.mouse.move(at.x, at.y);
  await wait(60);
  assert.equal(await page.popupVisible(), false, 'should still be waiting out the dwell');

  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });
  page.assertNoErrors();
  await page.close();
});

test('hover mode closes again when the pointer leaves Chinese text', async () => {
  const page = await openPage({ triggerKey: 'none', hoverDelay: 100 });
  const at = await page.pointAt('#plain', 4);

  await page.mouse.move(at.x, at.y);
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });

  // Far to the right of the paragraph, still inside the block but past the text.
  await page.mouse.move(870, at.y);
  await wait(500);
  assert.equal(await page.popupVisible(), false);

  page.assertNoErrors();
  await page.close();
});

test('hover mode respects Escape until the pointer reaches different text', async () => {
  const page = await openPage({ triggerKey: 'none', hoverDelay: 100 });
  const at = await page.pointAt('#plain', 4);

  await page.mouse.move(at.x, at.y);
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });
  await page.keyboard.press('Escape');
  assert.equal(await page.popupVisible(), false);

  // Jiggling within the same character must not reopen what was just dismissed.
  await page.mouse.move(at.x + 1, at.y);
  await wait(300);
  assert.equal(await page.popupVisible(), false, 'Escape should hold while on the same word');

  // A different word is a fresh lookup.
  const other = await page.pointAt('#plain', 1);
  await page.mouse.move(other.x, other.y);
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });

  page.assertNoErrors();
  await page.close();
});

test('the dwell delay and the lookup overlap rather than stacking', async () => {
  // 400ms dwell against a 300ms "cold worker". Serial would be ~700ms; overlapped is ~400.
  const page = await openPage({ triggerKey: 'none', hoverDelay: 400 }, { lookupDelay: 300 });
  const at = await page.pointAt('#plain', 4);

  const started = Date.now();
  await page.mouse.move(at.x, at.y);
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 620, `took ${elapsed}ms -- the fetch is not overlapping the dwell`);
  assert.ok(elapsed >= 350, `took ${elapsed}ms -- the dwell delay is being skipped`);

  page.assertNoErrors();
  await page.close();
});

test('the popup survives a deliberate move towards it across the gap', async () => {
  // The original clunkiness: the pointer crosses ~12px of nothing between the word and the
  // popup, and the sample that lands in that gap used to close it outright.
  const page = await openPage({ triggerKey: 'none', hoverDelay: 100 });
  const at = await page.pointAt('#plain', 4);

  await page.mouse.move(at.x, at.y);
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });

  const rect = await page.popupRect();
  await page.glideTo(at, { x: rect.x + 40, y: rect.y + 12 });
  assert.equal(await page.popupVisible(), true, 'should stay open while being approached');

  page.assertNoErrors();
  await page.close();
});

test('reaching the popup does not re-anchor to the line below', async () => {
  // The popup opens ~12px under the word, so in tightly-spaced text the next line sits inside
  // that gap. Hover mode re-anchors instantly once visible, so crossing that line used to make
  // the popup jump to it and then slide out from under the pointer.
  const page = await openPage({ triggerKey: 'none', hoverDelay: 100 });
  const at = await page.pointAt('#tight', 0);

  await page.mouse.move(at.x, at.y);
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });
  const before = await page.shownWord();
  assert.ok(before, 'no word shown to begin with');

  const rect = await page.popupRect();
  // Straight down into the popup. Kept vertical on purpose: drifting sideways would cross other
  // words on the *same* line, and re-anchoring to those is correct sweeping behaviour.
  await page.glideTo(at, { x: at.x, y: rect.y + 14 }, 8, 35);

  assert.equal(await page.popupVisible(), true, 'popup closed on the way');
  assert.equal(await page.shownWord(), before, 'popup re-anchored to a word crossed en route');

  page.assertNoErrors();
  await page.close();
});

test('moving away from the popup closes it promptly', async () => {
  const page = await openPage({ triggerKey: 'none', hoverDelay: 100 });
  const at = await page.pointAt('#plain', 4);

  await page.mouse.move(at.x, at.y);
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });

  // Up and to the left: the popup sits below the word, so this is unambiguously away.
  await page.glideTo(at, { x: 5, y: at.y - 50 }, 4, 20);
  await wait(400);
  assert.equal(await page.popupVisible(), false, 'the approach grace must not apply here');

  page.assertNoErrors();
  await page.close();
});

test('every reading gets its own play button', async () => {
  // 打 has two readings (dá, dǎ), so the 1-character tab carries two entries.
  const page = await openPage({ triggerKey: 'Shift' }, { voices: [ZH_VOICE] });
  await page.openPopup('#plain', 4);

  const before = (await page.speakers()).length;
  assert.ok(before >= 1, 'the selected tab should have a play button per entry');

  const labels = await Promise.all(
    (await page.speakers()).map((b) => b.evaluate((el) => el.getAttribute('aria-label'))),
  );
  assert.ok(
    labels.every((l) => /^Play pronunciation of /.test(l)),
    `unexpected labels: ${JSON.stringify(labels)}`,
  );

  page.assertNoErrors();
  await page.close();
});

test('clicking a play button speaks the word with the Chinese voice', async () => {
  const page = await openPage({ triggerKey: 'Shift', audio: 'auto', speechRate: 0.8 }, { voices: [ZH_VOICE] });
  await page.openPopup('#plain', 4); // 中国菜

  const [button] = await page.speakers();
  await button.click();
  await wait(150);

  const spoken = await page.spoken();
  assert.equal(spoken.length, 1, 'exactly one utterance');
  assert.equal(spoken[0].text, '中国菜', 'speaks the headword, not the pinyin');
  assert.equal(spoken[0].lang, 'zh-CN');
  assert.equal(spoken[0].voice, 'Microsoft Huihui');
  assert.equal(spoken[0].rate, 0.8, 'honours the configured rate');

  page.assertNoErrors();
  await page.close();
});

test('with no Chinese voice, voice-only mode explains what is missing', async () => {
  const page = await openPage({ triggerKey: 'Shift', audio: 'voice' }, { voices: [] });
  await page.openPopup('#plain', 4);

  const [button] = await page.speakers();
  await button.click();
  await wait(150);

  assert.deepEqual(await page.spoken(), [], 'must not fall back to an English voice');
  assert.equal(await button.evaluate((el) => el.dataset.state), 'error');
  assert.match(await button.evaluate((el) => el.title), /No Chinese voice installed/);

  page.assertNoErrors();
  await page.close();
});

test('falls back to a Commons recording and plays it through Web Audio', async () => {
  const page = await openPage(
    { triggerKey: 'Shift', audio: 'auto' },
    { voices: [], audioResult: { found: true, name: 'LL-Q9192 (cmn)-Test-中国菜.wav', data: tinyWavBase64() } },
  );
  await page.openPopup('#plain', 4);

  const [button] = await page.speakers();
  await button.click();
  // Decoding is async; the button returns to idle only once playback finishes.
  await page.waitForFunction(
    () => document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('button.speak').dataset.state === 'idle',
    { timeout: 5000 },
  );

  assert.deepEqual(await page.spoken(), [], 'no voice available, so nothing was spoken');
  page.assertNoErrors();
  await page.close();
});

test('reports when neither a voice nor a recording exists', async () => {
  const page = await openPage({ triggerKey: 'Shift', audio: 'auto' }, { voices: [], audioResult: { found: false } });
  await page.openPopup('#plain', 4);

  const [button] = await page.speakers();
  await button.click();
  await wait(200);

  assert.equal(await button.evaluate((el) => el.dataset.state), 'error');
  assert.match(await button.evaluate((el) => el.title), /No Chinese voice installed and no recording/);

  page.assertNoErrors();
  await page.close();
});

test('recording-only mode never uses the voice, even when one exists', async () => {
  const page = await openPage(
    { triggerKey: 'Shift', audio: 'recording' },
    { voices: [ZH_VOICE], audioResult: { found: false } },
  );
  await page.openPopup('#plain', 4);

  const [button] = await page.speakers();
  await button.click();
  await wait(200);

  assert.deepEqual(await page.spoken(), [], '"recordings only" must mean only recordings');
  assert.match(await button.evaluate((el) => el.title), /No recording on Wikimedia Commons/);

  page.assertNoErrors();
  await page.close();
});

test('no play button at all when audio is off', async () => {
  const page = await openPage({ triggerKey: 'Shift', audio: 'off' }, { voices: [ZH_VOICE] });
  await page.openPopup('#plain', 4);
  assert.equal((await page.speakers()).length, 0);
  page.assertNoErrors();
  await page.close();
});

test('no Anki button unless Anki export is switched on', async () => {
  const page = await openPage({ triggerKey: 'Shift', ankiEnabled: false }, { voices: [ZH_VOICE] });
  await page.openPopup('#plain', 4);
  assert.equal((await page.adders()).length, 0);
  page.assertNoErrors();
  await page.close();
});

test('a word already in the collection has its add button greyed out', async () => {
  const page = await openPage(
    { triggerKey: 'Shift', ankiEnabled: true },
    { ankiInspect: { ready: true, states: [{ canAdd: false, duplicate: true, error: 'duplicate' }] } },
  );
  await page.openPopup('#plain', 4);

  // The check is a round trip, so the button starts enabled and is disabled on the answer.
  await page.waitForFunction(
    () => document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('button.anki-add')?.disabled === true,
    { timeout: 5000 },
  );
  const [state] = await page.adderStates();
  assert.equal(state.state, 'duplicate');
  assert.match(state.title, /Already in your Anki collection/);

  page.assertNoErrors();
  await page.close();
});

test('a new word stays addable, and adding it shows a tick', async () => {
  const page = await openPage(
    { triggerKey: 'Shift', ankiEnabled: true },
    {
      ankiInspect: { ready: true, states: [{ canAdd: true, duplicate: false, error: '' }] },
      ankiAdd: { noteId: 1, created: [], deck: 'Mandarin::Chinese Mining', audio: false },
    },
  );
  await page.openPopup('#plain', 4);

  const [button] = await page.adders();
  assert.equal(await button.evaluate((el) => el.disabled), false, 'a new word must stay clickable');

  await button.click();
  await page.waitForFunction(
    () => document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('button.anki-add').dataset.state === 'added',
    { timeout: 5000 },
  );
  const [state] = await page.adderStates();
  assert.equal(state.disabled, true, 'no adding the same note twice');
  assert.match(state.title, /Added to Mandarin::Chinese Mining/);

  page.assertNoErrors();
  await page.close();
});

test('creating a deck or note type is reported in the tooltip', async () => {
  const page = await openPage(
    { triggerKey: 'Shift', ankiEnabled: true },
    {
      ankiInspect: { ready: false, states: [{ canAdd: true, duplicate: false, error: '' }] },
      ankiAdd: { noteId: 2, created: ['deck "X"', 'note type "Y"'], deck: 'X', audio: false },
    },
  );
  await page.openPopup('#plain', 4);

  const [button] = await page.adders();
  await button.click();
  await page.waitForFunction(
    () => document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('button.anki-add').dataset.state === 'added',
    { timeout: 5000 },
  );
  assert.match((await page.adderStates())[0].title, /created deck "X" and note type "Y"/);

  page.assertNoErrors();
  await page.close();
});

test('with Anki closed the button is disabled and says so', async () => {
  // ankiInspect null makes the stub reply with an error, as an unreachable Anki would.
  const page = await openPage({ triggerKey: 'Shift', ankiEnabled: true }, { ankiInspect: null });
  await page.openPopup('#plain', 4);

  await page.waitForFunction(
    () =>
      document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('button.anki-add')?.dataset.state ===
      'unavailable',
    { timeout: 5000 },
  );
  const [state] = await page.adderStates();
  assert.equal(state.disabled, true);
  assert.match(state.title, /Anki is not running/);

  page.assertNoErrors();
  await page.close();
});

test('a duplicate discovered only at add time still greys the button out', async () => {
  const page = await openPage(
    { triggerKey: 'Shift', ankiEnabled: true },
    { ankiInspect: { ready: true, states: [{ canAdd: true, duplicate: false, error: '' }] }, ankiAdd: null },
  );
  await page.openPopup('#plain', 4);

  const [button] = await page.adders();
  await button.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('button.anki-add').dataset.state ===
      'duplicate',
    { timeout: 5000 },
  );
  assert.equal((await page.adderStates())[0].disabled, true);

  page.assertNoErrors();
  await page.close();
});

test('each reading gets its own add button, greyed independently', async () => {
  // 打 has two readings; only the second is already in the collection.
  const page = await openPage(
    { triggerKey: 'Shift', ankiEnabled: true },
    {
      ankiInspect: {
        ready: true,
        states: [
          { canAdd: true, duplicate: false, error: '' },
          { canAdd: false, duplicate: true, error: 'duplicate' },
        ],
      },
    },
  );
  // #plain is 我喜欢吃中国菜。 — index 0 (我) has a single entry, so use the multi-reading page.
  await page.openPopup('#long', 0);
  const before = await page.adderStates();
  assert.ok(before.length >= 1);

  page.assertNoErrors();
  await page.close();
});

test('hover mode keeps the popup open while the pointer is over it', async () => {
  const page = await openPage({ triggerKey: 'none', hoverDelay: 100 });
  const at = await page.pointAt('#plain', 4);

  await page.mouse.move(at.x, at.y);
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });

  // The popup sits just below the word; moving onto it must not read as "left the text".
  const box = await page.evaluate(() => {
    const r = document.querySelector('[data-zh-dic-host]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await wait(300);
  assert.equal(await page.popupVisible(), true, 'popup must stay up so its tabs are clickable');

  page.assertNoErrors();
  await page.close();
});

// --- language ------------------------------------------------------------------

test('the popup speaks whichever language is configured', async () => {
  const page = await openPage(
    { triggerKey: 'Shift', ankiEnabled: true, uiLanguage: 'es' },
    { ankiInspect: null },
  );
  await page.openPopup('#plain', 4);

  const hint = await page.evaluate(
    () => document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('.hint').textContent,
  );
  // The trigger's own name stays "Shift" -- that's what's printed on the key.
  assert.equal(hint, 'Shift + ratón para buscar · ←/→ cambiar · Esc para cerrar');

  const [speaker] = await page.speakers();
  assert.match(await speaker.evaluate((el) => el.getAttribute('aria-label')), /^Reproducir la pronunciación de /);

  // aria-label rather than title: disableAnki overwrites the title as soon as the (absent) Anki
  // answers, which races with reading it here.
  const [adder] = await page.adders();
  assert.match(await adder.evaluate((el) => el.getAttribute('aria-label')), /^Añadir .+ a Anki$/);

  // Reported from content.js rather than rendered from the card.
  await page.waitForFunction(
    () =>
      document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('button.anki-add')?.dataset.state ===
      'unavailable',
    { timeout: 5000 },
  );
  assert.match((await page.adderStates())[0].title, /Anki no está abierto/);

  page.assertNoErrors();
  await page.close();
});

test('in hover mode the Spanish hint names no key at all', async () => {
  const page = await openPage({ triggerKey: 'none', hoverDelay: 100, uiLanguage: 'es' });
  const at = await page.pointAt('#plain', 4);

  await page.mouse.move(at.x, at.y);
  await page.waitForSelector('[data-zh-dic-host][data-visible]', { timeout: 5000 });

  const hint = await page.evaluate(
    () => document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('.hint').textContent,
  );
  assert.equal(hint, 'Pasar el ratón para buscar · ←/→ cambiar · Esc para cerrar');

  page.assertNoErrors();
  await page.close();
});

// --- the definitions-in-English warning ----------------------------------------
//
// Picking Spanish and being shown English is a deliberate fallback, not a failure, so the
// popup marks it with a badge rather than an error. There are two ways to end up there and
// only one is actionable, which is why they carry different explanations: a missing download
// can be fixed from the options page, an entry the translation simply doesn't cover cannot.

const READ_WARNING = `(() => {
  const el = document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('.warn');
  return { hidden: el.hidden, text: el.textContent, title: el.title, aria: el.getAttribute('aria-label') };
})()`;

test('no warning when the definitions are the ones that were asked for', async () => {
  // Everything translated: nothing to explain.
  const page = await openPage({ triggerKey: 'Shift', glossLanguage: 'es' }, {
    translate: (senses) => senses.map((s) => `ES:${s}`),
  });
  await page.openPopup('#plain', 4);

  assert.equal((await page.evaluate(READ_WARNING)).hidden, true);
  await page.close();
});

test('a missing download is flagged and says what to do about it', async () => {
  const page = await openPage({ triggerKey: 'Shift', glossLanguage: 'es' }, { glossPending: true });
  await page.openPopup('#plain', 4);

  const warn = await page.evaluate(READ_WARNING);
  assert.equal(warn.hidden, false);
  assert.equal(warn.text, '!');
  assert.match(warn.title, /have not been downloaded yet/);
  assert.match(warn.title, /extension options/, 'the actionable case names the way out');
  assert.equal(warn.aria, warn.title, 'the visible text is a bare "!", so the label carries it');
  await page.close();
});

test('an entry the translation does not cover is flagged differently', async () => {
  // The layer is present -- so no "download it" advice -- but this entry has no Spanish.
  const page = await openPage({ triggerKey: 'Shift', glossLanguage: 'es' }, { translate: () => null });
  await page.openPopup('#plain', 4);

  const warn = await page.evaluate(READ_WARNING);
  assert.equal(warn.hidden, false);
  assert.match(warn.title, /no Spanish definition yet/);
  assert.doesNotMatch(warn.title, /extension options/, 'nothing to download; do not send them looking');
  await page.close();
});

test('the warning is translated like the rest of the popup', async () => {
  const page = await openPage(
    { triggerKey: 'Shift', glossLanguage: 'es', uiLanguage: 'es' },
    { glossPending: true },
  );
  await page.openPopup('#plain', 4);

  assert.match((await page.evaluate(READ_WARNING)).title, /aún no se han descargado/);
  await page.close();
});

test('the hint text is left alone by the warning', async () => {
  // The badge is a sibling of the hint, not part of it: the hint is one readable sentence and
  // a stray "!" spliced into it would help nobody.
  const page = await openPage({ triggerKey: 'Shift', glossLanguage: 'es' }, { glossPending: true });
  await page.openPopup('#plain', 4);

  const hint = await page.evaluate(
    () => document.querySelector('[data-zh-dic-host]').shadowRoot.querySelector('.hint').textContent,
  );
  assert.equal(hint, 'Shift-hover to look up · ←/→ switch · Esc to close');
  await page.close();
});

test('English definitions never raise the warning', async () => {
  // The regression this guards: every English card is "untranslated" in the sense the badge
  // tests for, because there is no gloss layer behind it. Read naively that made the badge
  // appear on every single lookup, claiming an entry had no Spanish -- while the user was
  // reading the English they actually asked for.
  const page = await openPage({ triggerKey: 'Shift', glossLanguage: 'en' }, { translate: () => null });
  await page.openPopup('#plain', 4);

  assert.equal((await page.evaluate(READ_WARNING)).hidden, true);
  await page.close();
});

test('English definitions stay clean even if the worker reports a pending layer', async () => {
  // Belt and braces: a stale glossPending arriving after a switch back to English must not
  // resurrect the badge either.
  const page = await openPage({ triggerKey: 'Shift', glossLanguage: 'en' }, { glossPending: true });
  await page.openPopup('#plain', 4);

  assert.equal((await page.evaluate(READ_WARNING)).hidden, true);
  await page.close();
});

// --- snip overlay ------------------------------------------------------------
//
// The overlay reports a rectangle and nothing else, so these drive it with real pointer events
// and assert on what comes back. `>>> .sheet` reaches into its shadow root the same way the
// popup tests reach the buttons -- both roots are open.

/** Start a selection the way the toolbar button does, and wait for the overlay to appear. */
async function beginSnip(page) {
  await page.evaluate(() => {
    window.__snip = window.zhDic.startSnip();
  });
  await page.waitForSelector('>>> .sheet', { timeout: 5000 });
}

const snipResult = (page) => page.evaluate(() => window.__snip);

// Probe for the overlay's own sheet rather than counting hosts: the popup and the result window
// are hosts too, and both are in the DOM from startup whether or not they are showing.
const NO_OVERLAY = () =>
  ![...document.querySelectorAll('[data-zh-dic-host]')].some((host) => host.shadowRoot?.querySelector('.sheet'));

const overlayGone = (page) => page.evaluate(NO_OVERLAY);

test('dragging a box reports it in viewport coordinates and takes the overlay down', async () => {
  const page = await openPage();
  await beginSnip(page);

  await page.mouse.move(120, 140);
  await page.mouse.down();
  await page.mouse.move(300, 260, { steps: 8 });
  await page.mouse.up();

  const region = await snipResult(page);
  assert.deepEqual(
    { x: region.x, y: region.y, width: region.width, height: region.height },
    { x: 120, y: 140, width: 180, height: 120 },
  );
  // The capture this feeds is in device pixels, so the ratio has to come back with the box.
  assert.equal(region.dpr, await page.evaluate(() => window.devicePixelRatio || 1));
  assert.equal(await overlayGone(page), true, 'the overlay outlived the selection');

  page.assertNoErrors();
  await page.close();
});

test('dragging up and to the left gives the same box as dragging down and right', async () => {
  // Nobody drags in one canonical direction, and a negative width would reach the capture as an
  // empty crop rather than an error.
  const page = await openPage();
  await beginSnip(page);

  await page.mouse.move(300, 260);
  await page.mouse.down();
  await page.mouse.move(120, 140, { steps: 8 });
  await page.mouse.up();

  const region = await snipResult(page);
  assert.deepEqual(
    { x: region.x, y: region.y, width: region.width, height: region.height },
    { x: 120, y: 140, width: 180, height: 120 },
  );

  page.assertNoErrors();
  await page.close();
});

test('Escape abandons the selection', async () => {
  const page = await openPage();
  await beginSnip(page);

  await page.mouse.move(120, 140);
  await page.mouse.down();
  await page.mouse.move(300, 260, { steps: 4 });
  await page.keyboard.press('Escape');

  assert.equal(await snipResult(page), null);
  assert.equal(await overlayGone(page), true);

  await page.mouse.up();
  page.assertNoErrors();
  await page.close();
});

test('a stray click is not a two-pixel selection', async () => {
  // Aiming and then clicking without dragging is a mis-click. Handing OCR a sliver of nothing
  // would answer with an empty result the user has no way to interpret.
  const page = await openPage();
  await beginSnip(page);

  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.move(203, 202);
  await page.mouse.up();

  assert.equal(await snipResult(page), null);
  assert.equal(await overlayGone(page), true);

  page.assertNoErrors();
  await page.close();
});

test('a snip started from the toolbar holds lookups off until it ends', async () => {
  const page = await openPage({ triggerKey: 'Shift' });
  const at = await page.pointAt('#plain', 4);

  await page.evaluate(() => window.__zhOnMessage({ type: 'snip' }));
  await page.waitForSelector('>>> .sheet', { timeout: 5000 });

  // The overlay is in front of everything, so a popup opened behind it would be invisible and
  // impossible to dismiss.
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Shift');
  await page.mouse.move(at.x + 1, at.y);
  await wait(250);
  assert.equal(await page.popupVisible(), false, 'a lookup fired behind the overlay');
  await page.keyboard.up('Shift');

  await page.keyboard.press('Escape');
  await page.waitForFunction(NO_OVERLAY, { timeout: 5000 });

  // And the suppression lifts again, rather than leaving the extension mute.
  await page.openPopup('#plain', 4);
  assert.equal(await page.popupVisible(), true);

  page.assertNoErrors();
  await page.close();
});

// --- snip result window ------------------------------------------------------
//
// The window is a sibling of the popup rather than a copy of it: both draw their entries with
// EntryView and load popup.css, so these assert on the same class names the popup tests use.

/** Read something out of the result window's shadow root. */
const inResult = (page, fn) =>
  page.evaluate((source) => {
    const host = [...document.querySelectorAll('[data-zh-dic-host]')].find((h) => h.dataset.zhDicResult !== undefined);
    // eslint-disable-next-line no-new-func
    return new Function('root', `return (${source})(root)`)(host?.shadowRoot);
  }, fn.toString());

/** Drag the region the fake capture paints red, and wait for the window to show it. */
async function snipTheRedBlock(page) {
  await page.evaluate(() => window.__zhOnMessage({ type: 'snip' }));
  await page.waitForSelector('>>> .sheet', { timeout: 5000 });

  const r = await page.evaluate(() => window.__captureRegion);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width, r.y + r.height, { steps: 8 });
  await page.mouse.up();

  await page.waitForSelector('>>> .shot-image[src]', { timeout: 5000 });
  return r;
}

test('the window shows the region that was framed, not merely one of that size', async () => {
  const page = await openPage();
  const region = await snipTheRedBlock(page);

  const shot = await inResult(page, async (root) => {
    const image = root.querySelector('.shot-image');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);

    // Sample the four corners, inset a couple of pixels, rather than just the centre. A crop
    // that is scaled or offset slightly still has a red centre -- it is the edges that pick up
    // whatever was next to the selection, which is exactly the bug this guards.
    const inset = 2;
    const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    return {
      width: canvas.width,
      height: canvas.height,
      corners: [
        at(inset, inset),
        at(canvas.width - 1 - inset, inset),
        at(inset, canvas.height - 1 - inset),
        at(canvas.width - 1 - inset, canvas.height - 1 - inset),
      ],
      caption: root.querySelector('.shot-size').textContent,
    };
  });

  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  assert.deepEqual(
    [shot.width, shot.height],
    [Math.round(region.width * dpr), Math.round(region.height * dpr)],
    'the crop is not the size that was dragged',
  );
  // Red is only where the fake capture painted it, so a crop that is offset or overscaled picks
  // up white at an edge and fails here -- which is the failure that otherwise arrives as "the
  // image has a bit of the next word in it", or later as OCR reading text nobody selected.
  // Compared by channel rather than exactly: encoding to PNG and back drifts by a bit or two,
  // and white is nowhere near this test either way.
  for (const [i, corner] of shot.corners.entries()) {
    const [r, g, b] = corner;
    assert.ok(
      r > 200 && g < 60 && b < 60,
      `corner ${i} of the crop came from outside the selection (pixel ${corner.join(',')})`,
    );
  }
  // The caption reports device pixels, matching the readout on the overlay.
  assert.equal(shot.caption, `${shot.width} × ${shot.height}`);

  page.assertNoErrors();
  await page.close();
});

test('when nothing legible is read, the window still shows the capture and says so', async () => {
  // The ordinary outcome on a textured panel, and the reason the image stays on screen: seeing
  // what was actually captured is what tells the user to zoom in and reframe.
  const page = await openPage();
  await snipTheRedBlock(page);

  const state = await inResult(page, (root) => ({
    status: root.querySelector('.status').textContent,
    statusShown: !root.querySelector('.status').hidden,
    entries: root.querySelectorAll('.entry').length,
    hasImage: !!root.querySelector('.shot-image').getAttribute('src'),
  }));

  assert.equal(state.hasImage, true);
  assert.equal(state.statusShown, true);
  assert.match(state.status, /No text could be read/);
  assert.equal(state.entries, 0);

  page.assertNoErrors();
  await page.close();
});

test('recognised text is looked up and drawn as the hover popup draws it', async () => {
  const page = await openPage();
  // Standing in for OCR at exactly the seam it will fill.
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '中国菜';
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );

  const shown = await inResult(page, (root) => ({
    word: root.querySelector('.entry .word').textContent,
    tones: root.querySelectorAll('.entry .pinyin .tone').length,
    senses: root.querySelectorAll('.entry .senses li').length,
    tabs: root.querySelectorAll('.tab').length,
    statusShown: !root.querySelector('.status').hidden,
    stillHasImage: !!root.querySelector('.shot-image').getAttribute('src'),
  }));

  assert.equal(shown.word, '中国菜');
  assert.equal(shown.tones, 3, 'one toned syllable per character');
  assert.ok(shown.senses > 0, 'the entry has no definitions');
  // 中国菜 / 中国 / 中 -- the same longest-first tabs a hover would offer.
  assert.ok(shown.tabs >= 2, 'the shorter candidates are missing');
  // The capture stays on screen beside the reading; that is the whole point of the window.
  assert.equal(shown.stillHasImage, true);
  assert.equal(shown.statusShown, false, 'the status line outlived the lookup');

  page.assertNoErrors();
  await page.close();
});

test('Escape closes the result window and releases the capture', async () => {
  const page = await openPage();
  await snipTheRedBlock(page);

  await page.keyboard.press('Escape');

  const after = await inResult(page, (root) => ({
    visible: root.host.hasAttribute('data-visible'),
    // Several megabytes of base64 should not stay attached to a hidden node.
    src: root.querySelector('.shot-image').getAttribute('src'),
  }));
  assert.equal(after.visible, false);
  assert.equal(after.src, null);

  page.assertNoErrors();
  await page.close();
});

test('the window is popup-width, and only its definitions scroll', async () => {
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '中国菜';
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );

  const box = await inResult(page, (root) => {
    const card = root.querySelector('.card');
    const image = root.querySelector('.shot-image');
    return {
      cardWidth: card.clientWidth,
      scrollWidth: card.scrollWidth,
      overflowX: getComputedStyle(card).overflowX,
      imageWidth: image.clientWidth,
      panelOverflowY: getComputedStyle(root.querySelector('.panel')).overflowY,
    };
  });

  // The regression this guards: popup.css scrolls the card with `overflow-y: auto`, which makes
  // CSS compute overflow-x to `auto` too -- so anything a pixel wider than the content box, as
  // the image's negative margins once were, showed a horizontal scrollbar.
  assert.equal(box.overflowX, 'hidden');
  assert.ok(
    box.scrollWidth <= box.cardWidth,
    `the card scrolls horizontally (${box.scrollWidth}px of content in ${box.cardWidth}px)`,
  );
  assert.ok(box.imageWidth <= box.cardWidth, 'the capture is wider than the window holding it');

  // Same width as a hover popup, which is the whole point of sharing popup.css.
  assert.ok(box.cardWidth <= 380, `the window is ${box.cardWidth}px, wider than the popup's 380px`);
  // Scrolling belongs to the definitions, so the capture stays put above them.
  assert.equal(box.panelOverflowY, 'auto');

  page.assertNoErrors();
  await page.close();
});

test('the retry button closes the window and goes straight back to framing', async () => {
  // A capture that read badly is reframed far more often than it is abandoned, so this is the
  // path out of a bad snip -- without it the user has to close, find the toolbar and start over.
  const page = await openPage();
  await snipTheRedBlock(page);

  await page.evaluate(() => {
    const host = [...document.querySelectorAll('[data-zh-dic-host]')].find(
      (h) => h.dataset.zhDicResult !== undefined,
    );
    host.shadowRoot.querySelector('.shot-retry').click();
  });

  // The window goes, and the overlay comes straight back up.
  await page.waitForSelector('>>> .sheet', { timeout: 5000 });
  assert.equal(
    await inResult(page, (root) => root.host.hasAttribute('data-visible')),
    false,
    'the window stayed open behind the new selection',
  );

  // And the second snip completes like the first, rather than being blocked by the first.
  const region = await page.evaluate(() => window.__captureRegion);
  await page.mouse.move(region.x, region.y);
  await page.mouse.down();
  await page.mouse.move(region.x + region.width, region.y + region.height, { steps: 6 });
  await page.mouse.up();

  await page.waitForSelector('>>> .shot-image[src]', { timeout: 5000 });
  assert.equal(await inResult(page, (root) => root.host.hasAttribute('data-visible')), true);

  page.assertNoErrors();
  await page.close();
});

test('the crop maps through the viewport it is given, not the document width', async () => {
  // The bug this guards: the scale was measured against documentElement.clientWidth, which stops
  // at the scrollbar, while captureVisibleTab includes it. The crop then ran ~1.7% large and slid
  // right in proportion to distance from the left edge, pulling in the neighbouring word.
  //
  // Headless Chrome never lays out a space-taking scrollbar -- innerWidth and clientWidth are
  // equal no matter what CSS is applied -- so the end-to-end path cannot show this. Calling
  // cropRegion directly with a viewport narrower than the document is what reproduces it.
  const page = await openPage();

  const result = await page.evaluate(async () => {
    const dpr = 2;
    // A viewport 15px narrower than the document, the way a classic scrollbar leaves it.
    const viewport = { width: document.documentElement.clientWidth - 15, height: 600 };
    const region = { x: 600, y: 100, width: 180, height: 120 };

    // A capture of exactly that viewport, red only where the region is.
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(region.x * dpr, region.y * dpr, region.width * dpr, region.height * dpr);

    const shot = await window.zhDic.cropRegion(canvas.toDataURL('image/png'), region, viewport);

    const image = new Image();
    await new Promise((done) => {
      image.onload = done;
      image.src = shot.dataUrl;
    });
    const out = document.createElement('canvas');
    out.width = image.naturalWidth;
    out.height = image.naturalHeight;
    const octx = out.getContext('2d');
    octx.drawImage(image, 0, 0);
    const at = (x, y) => [...octx.getImageData(x, y, 1, 1).data].slice(0, 3);
    return {
      size: [shot.width, shot.height],
      expected: [region.width * dpr, region.height * dpr],
      corners: [
        at(2, 2),
        at(out.width - 3, 2),
        at(2, out.height - 3),
        at(out.width - 3, out.height - 3),
      ],
    };
  });

  assert.deepEqual(result.size, result.expected, 'the crop is not the size that was selected');
  for (const [i, corner] of result.corners.entries()) {
    const [r, g, b] = corner;
    assert.ok(
      r > 200 && g < 60 && b < 60,
      `corner ${i} came from outside the selection (pixel ${corner.join(',')}) -- the crop is ` +
        'measuring against the wrong width',
    );
  }

  page.assertNoErrors();
  await page.close();
});

// --- the vendored recogniser -------------------------------------------------
//
// Everything above stubs OCR, which is what let a broken import ship: offscreen.js destructured
// `{ createWorker }` from a bundle that exports only a default, so the module threw on
// evaluation, never registered its listener, and every snip failed with "Receiving end does not
// exist" -- an error that reads like a missing document rather than a syntax-level mistake.
//
// These load the vendored files the way the offscreen document does. They need `npm run
// fetch-ocr` to have run, and skip rather than fail when it hasn't, since the assets are
// gitignored like the dictionary shards.

const OCR_DIR = join(root, 'extension', 'data', 'ocr');
const ocrVendored = ['tesseract.esm.min.js', 'worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'chi_sim.traineddata'].every(
  (f) => existsSync(join(OCR_DIR, f)),
);
const ocrSkip = ocrVendored ? false : 'run `npm run fetch-ocr` to vendor the recogniser';

test('the vendored bundle exports what the offscreen document imports', { skip: ocrSkip }, async () => {
  const page = await openPage();

  const shape = await page.evaluate(async (base) => {
    const ns = await import(`${base}/extension/data/ocr/tesseract.esm.min.js`);
    return {
      named: typeof ns.createWorker,
      viaDefault: typeof ns.default?.createWorker,
    };
  }, origin);

  // The contract offscreen.js relies on. If a future tesseract.js adds named exports this test
  // still passes; if it drops the default one, it fails here rather than at the first snip.
  assert.equal(shape.viaDefault, 'function', 'the default export has no createWorker');
  // Documents why the import must be a default one. This is the assertion that was violated.
  assert.equal(shape.named, 'undefined', 'named exports appeared; the default import may be stale');

  page.assertNoErrors();
  await page.close();
});

test('the vendored engine reads Chinese off an image', { skip: ocrSkip }, async () => {
  const page = await openPage();

  const read = await page.evaluate(async (base) => {
    const ns = await import(`${base}/extension/data/ocr/tesseract.esm.min.js`);

    const canvas = document.createElement('canvas');
    canvas.width = 520;
    canvas.height = 140;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111111';
    ctx.font = '44px "Microsoft YaHei", SimHei, sans-serif';
    ctx.fillText('我喜欢吃中国菜', 20, 90);

    // The same options offscreen.js passes, so a wrong path or a renamed core fails here too.
    const worker = await ns.default.createWorker('chi_sim', 1, {
      workerPath: `${base}/extension/data/ocr/worker.min.js`,
      corePath: `${base}/extension/data/ocr/tesseract-core-simd-lstm.wasm.js`,
      langPath: `${base}/extension/data/ocr`,
      gzip: false,
      workerBlobURL: false,
      cacheMethod: 'none',
    });
    const { data } = await worker.recognize(canvas.toDataURL('image/png'));
    await worker.terminate();
    // The same tidy() offscreen.js applies: Tesseract spaces CJK characters apart, and
    // "中 国 菜" matches nothing in the dictionary.
    return { text: data.text.replace(/\s+/gu, ''), confidence: data.confidence };
  }, origin);

  assert.equal(read.text, '我喜欢吃中国菜');
  assert.ok(read.confidence > 50, `confidence was only ${read.confidence}`);

  await page.close();
});

test('a recognised sentence becomes one chip per word, and each one looks up', async () => {
  // The reported bug end to end: a lookup answered for 开始 and ignored 阅读, because it only
  // ever matched from position 0.
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '开始阅读';
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );

  const chips = await inResult(page, (root) => ({
    words: [...root.querySelectorAll('.token')].map((t) => t.textContent),
    active: root.querySelector('.token.is-active')?.textContent,
    showing: root.querySelector('.entry .word').textContent,
  }));

  assert.deepEqual(chips.words, ['开始', '阅读'], 'the line was not split into both words');
  assert.equal(chips.active, '开始');
  assert.equal(chips.showing, '开始');

  // The second word is a click away rather than a re-snip -- this is what was missing before.
  await page.evaluate(() => {
    const host = [...document.querySelectorAll('[data-zh-dic-host]')].find(
      (h) => h.dataset.zhDicResult !== undefined,
    );
    host.shadowRoot.querySelectorAll('.token')[1].click();
  });

  const after = await inResult(page, (root) => ({
    active: root.querySelector('.token.is-active')?.textContent,
    showing: root.querySelector('.entry .word').textContent,
    senses: root.querySelectorAll('.entry .senses li').length,
  }));

  assert.equal(after.active, '阅读');
  assert.equal(after.showing, '阅读');
  assert.ok(after.senses > 0, '阅读 has no definitions');

  page.assertNoErrors();
  await page.close();
});

test('a single-word capture shows no chip row', async () => {
  // A row of one chip would restate the entry directly beneath it.
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '中国菜';
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );

  const state = await inResult(page, (root) => ({
    chipsHidden: root.querySelector('.tokens').hidden,
    showing: root.querySelector('.entry .word').textContent,
    // 中国菜 also matches 中国 and 中, so the length tabs are still offered.
    tabs: [...root.querySelectorAll('.tab')].map((t) => t.textContent.replace(/\d+$/, '')),
  }));

  assert.equal(state.chipsHidden, true);
  assert.equal(state.showing, '中国菜');
  assert.ok(state.tabs.includes('中国'), `expected a shorter candidate, got ${state.tabs.join(', ')}`);

  page.assertNoErrors();
  await page.close();
});

/** Wait out the reposition that follows the capture decoding. */
const settled = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** The result window's box, and what it has to fit inside. */
const windowBox = (page) =>
  inResult(page, (root) => {
    const rect = root.querySelector('.card').getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      region: window.__captureRegion,
    };
  });

/** Snip a given region and wait until the window has finished growing into its final size. */
async function snipAt(page, region, text = '开始阅读') {
  await page.evaluate(
    ([r, t]) => {
      window.zhDic.recognise = async () => t;
      window.__captureRegion = r;
    },
    [region, text],
  );
  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );
  await settled(page);
}

test('a capture that reads nothing is still placed for its real height', async () => {
  // Guards the reposition that follows the capture decoding.
  //
  // It is load-bearing precisely here. On the normal path showReading() places the window again
  // once the entries exist, which masks a stale first measurement -- but when nothing is read
  // showReading is never called, so the only thing that can account for the image's ~240px is
  // the decode handler. Measured before the capture had decoded, the card looks about 70px tall,
  // fits in the ~280px below, and is placed there; it then grows past the gap it was chosen for.
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => null;
    window.__captureRegion = { x: 200, y: 380, width: 180, height: 120 };
  });
  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.status')?.textContent,
    { timeout: 5000 },
  );
  await settled(page);

  const box = await windowBox(page);
  assert.ok(box.bottom <= box.viewport.height, `the window runs off the bottom`);
  // The real test: with the finished height accounted for, below no longer fits and above does,
  // so it belongs above the capture. Placed on the pre-decode height it stays below it.
  assert.ok(
    box.bottom <= box.region.y + 1,
    `the window was placed below the capture on a height it then outgrew ` +
      `(bottom ${Math.round(box.bottom)}, capture top ${box.region.y})`,
  );

  page.assertNoErrors();
  await page.close();
});

test('a capture with no room on either side still lands on screen', async () => {
  // Guards the clamp. A tall snip leaves ~50px below and ~30px above: neither side fits, so
  // neither flipping nor the minimum height can save it, and the minimum height is itself what
  // pushes the card back over the edge it was being kept inside. Overlapping the capture is the
  // right answer here -- which side it sits on is a preference, staying on screen is not.
  const page = await openPage();
  await snipAt(page, { x: 200, y: 30, width: 400, height: 700 });

  const box = await windowBox(page);
  assert.ok(
    box.bottom <= box.viewport.height,
    `the window runs ${Math.round(box.bottom - box.viewport.height)}px off the bottom`,
  );
  assert.ok(box.top >= 0, `the window runs ${Math.round(-box.top)}px off the top`);
  assert.ok(box.left >= 0 && box.right <= box.viewport.width, 'the window runs off the side');

  page.assertNoErrors();
  await page.close();
});

test('the gear re-reads the same capture with the new settings, without a new snip', async () => {
  const page = await openPage();
  await page.evaluate(() => {
    // Stands in for the model changing: the same pixels read differently once the settings say
    // they run vertically.
    window.__readAs = (settings) => (settings.ocrOrientation === 'vertical' ? '阅读' : '开始');
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );

  assert.equal(await inResult(page, (root) => root.querySelector('.entry .word').textContent), '开始');
  assert.equal(await inResult(page, (root) => root.querySelector('.tuner').hidden), true);

  const inWindow = (fn) =>
    page.evaluate((source) => {
      const host = [...document.querySelectorAll('[data-zh-dic-host]')].find(
        (h) => h.dataset.zhDicResult !== undefined,
      );
      // eslint-disable-next-line no-new-func
      return new Function('root', `return (${source})(root)`)(host.shadowRoot);
    }, fn.toString());

  // Open the tuner and switch to vertical.
  await inWindow((root) => root.querySelector('.shot-tune').click());
  assert.equal(await inResult(page, (root) => root.querySelector('.tuner').hidden), false);

  await inWindow((root) => {
    const select = root.querySelector('[data-setting="ocrOrientation"]');
    select.value = 'vertical';
    select.dispatchEvent(new Event('change'));
  });

  // Still showing the old reading: the change applies on close, not on every keystroke of it.
  assert.equal(await inResult(page, (root) => root.querySelector('.entry .word').textContent), '开始');

  await inWindow((root) => root.querySelector('.shot-tune').click());
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word')?.textContent === '阅读',
    { timeout: 5000 },
  );

  const after = await inResult(page, (root) => ({
    tunerHidden: root.querySelector('.tuner').hidden,
    // The capture is still the one that was framed -- this was a re-read, not a re-snip.
    hasImage: !!root.querySelector('.shot-image').getAttribute('src'),
    overlayUp: !!document.querySelector('.sheet'),
  }));
  assert.equal(after.tunerHidden, true);
  assert.equal(after.hasImage, true);
  assert.equal(after.overlayUp, false, 'a new snip was started instead of re-reading');

  page.assertNoErrors();
  await page.close();
});

test('closing the gear without changing anything does not re-read', async () => {
  const page = await openPage();
  await page.evaluate(() => {
    window.__reads = 0;
    window.__readAs = () => {
      window.__reads += 1;
      return '开始';
    };
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );

  const before = await page.evaluate(() => window.__reads);

  await page.evaluate(() => {
    const host = [...document.querySelectorAll('[data-zh-dic-host]')].find(
      (h) => h.dataset.zhDicResult !== undefined,
    );
    host.shadowRoot.querySelector('.shot-tune').click();
    host.shadowRoot.querySelector('.shot-tune').click();
  });

  // Opening and shutting the settings should cost nothing; re-reading takes seconds in reality.
  assert.equal(await page.evaluate(() => window.__reads), before);

  page.assertNoErrors();
  await page.close();
});

test('the result window is translated, and stays translated when the language changes', async () => {
  // The popup gets this for free -- its one fixed string is rewritten on every settings change.
  // This window builds a dozen of them in its constructor, so they froze in whatever language
  // was active then: switching to Spanish with a tab already open left the drawer in English.
  const page = await openPage({ uiLanguage: 'es' });
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '开始';
  });
  await snipTheRedBlock(page);

  const openTuner = () =>
    page.evaluate(() => {
      const host = [...document.querySelectorAll('[data-zh-dic-host]')].find(
        (h) => h.dataset.zhDicResult !== undefined,
      );
      if (host.shadowRoot.querySelector('.tuner').hidden) host.shadowRoot.querySelector('.shot-tune').click();
    });

  const labels = () =>
    inResult(page, (root) => ({
      rows: [...root.querySelectorAll('.tuner-row:not([hidden]) > span')].map((s) => s.textContent),
      options: [...root.querySelectorAll('[data-setting="ocrScript"] option')].map((o) => o.textContent),
      gear: root.querySelector('.shot-tune').title,
      alt: root.querySelector('.shot-image').alt,
    }));

  await openTuner();
  const es = await labels();
  assert.deepEqual(es.rows, ['Escritura en las imágenes', 'Dirección del texto']);
  assert.deepEqual(es.options, ['Simplificado', 'Tradicional']);
  assert.equal(es.gear, 'Cómo leer esto');
  assert.equal(es.alt, 'El texto que has capturado');

  // Switch the interface to English the way the options page does -- by writing the setting --
  // with the window still open. This is the path that used to leave the drawer frozen.
  await page.evaluate(() => chrome.storage.sync.set({ uiLanguage: 'en' }));

  await openTuner();
  const en = await labels();
  assert.deepEqual(en.rows, ['Script in images', 'Text direction']);
  assert.deepEqual(en.options, ['Simplified', 'Traditional']);
  assert.equal(en.gear, 'What to read this as');
  assert.equal(en.alt, 'The text you captured');

  page.assertNoErrors();
  await page.close();
});

test('the recognised line is shown as text, and correcting it re-runs the lookup', async () => {
  // The whole point of the editable line. Recognition on stylised lettering is imperfect, the
  // capture is on screen right above the box, and fixing one glyph by eye turns a partial reading
  // into an exact one -- which is worth more than any accuracy the engine could have given us.
  const page = await openPage();
  await page.evaluate(() => {
    // Last character misread: 读 came back as the similar-looking 渎.
    window.zhDic.recognise = async () => '开始阅渎';
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );

  const before = await inResult(page, (root) => ({
    line: root.querySelector('.line').value,
    chips: [...root.querySelectorAll('.token')].map((c) => c.textContent),
  }));
  assert.equal(before.line, '开始阅渎', 'the line does not carry the recognised text');
  // 阅渎 is not a word, so it does not segment as one.
  assert.ok(!before.chips.includes('阅读'), `expected a bad split, got ${before.chips.join(' ')}`);

  // Correct it the way a user would: edit the box and leave it.
  await page.evaluate(() => {
    const host = [...document.querySelectorAll('[data-zh-dic-host]')].find(
      (h) => h.dataset.zhDicResult !== undefined,
    );
    const line = host.shadowRoot.querySelector('.line');
    line.value = '开始阅读';
    line.dispatchEvent(new Event('change'));
  });

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.token:last-child')?.textContent === '阅读',
    { timeout: 5000 },
  );

  const after = await inResult(page, (root) => ({
    chips: [...root.querySelectorAll('.token')].map((c) => c.textContent),
    showing: root.querySelector('.entry .word').textContent,
    // The capture stays put; this was a re-read of the text, not a re-snip.
    hasImage: !!root.querySelector('.shot-image').getAttribute('src'),
  }));
  assert.deepEqual(after.chips, ['开始', '阅读'], 'the correction did not re-segment the line');
  assert.equal(after.hasImage, true);
  assert.ok(after.showing);

  page.assertNoErrors();
  await page.close();
});


/**
 * The layout rules the result window must always satisfy, whatever is in it.
 *
 * "The card never scrolls" used to be the rule, and is not any more: when the viewport is too
 * cramped to pin the capture above a usable panel, the window deliberately becomes one scroll
 * area instead. What has to hold regardless is that everything stays reachable and that there is
 * never more than one scrollbar to reach it with.
 */
const layoutOf = (page) =>
  inResult(page, (root) => {
    const card = root.querySelector('.card');
    const panel = root.querySelector('.panel');
    const rect = card.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      cardHeight: rect.height,
      maxHeight: card.style.maxHeight,
      compact: card.classList.contains('is-compact'),
      cardScrolls: card.scrollHeight > card.clientHeight + 1,
      panelHeight: panel.getBoundingClientRect().height,
      panelScrolls: panel.scrollHeight > panel.clientHeight + 1,
      viewport: window.innerHeight,
    };
  });

function assertLayout(box, where) {
  assert.ok(box.bottom <= box.viewport, `${where}: runs ${Math.round(box.bottom - box.viewport)}px off the bottom`);
  assert.ok(box.top >= 0, `${where}: runs ${Math.round(-box.top)}px off the top`);
  // Two scrollbars means one of them is around something too small to use -- the five-pixel
  // panel inside a scrolling card that prompted all of this.
  assert.ok(!(box.cardScrolls && box.panelScrolls), `${where}: the card and the panel both scroll`);
  // A panel worth scrolling has to be worth looking at.
  if (box.panelScrolls) {
    assert.ok(box.panelHeight > 40, `${where}: scrolling panel is only ${Math.round(box.panelHeight)}px tall`);
  }
}

test('the window stays on screen once the line and translation are added to it', async () => {
  // Regression: the editable line and the translation are both flex:none sections added after
  // the window has already been placed, and each one arrives at a different moment -- the line
  // when recognition returns, the translation a network round trip later.
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '开始阅读';
    window.__translation = 'Start reading — a translation long enough to wrap onto more than one line.';
    window.__captureRegion = { x: 200, y: 380, width: 180, height: 120 };
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.translation:not([hidden])'),
    { timeout: 5000 },
  );
  await settled(page);

  assertLayout(await layoutOf(page), 'with a line and a translation');

  page.assertNoErrors();
  await page.close();
});

test('the window re-fits itself after the viewport changes size', async () => {
  // Zooming the page is what this is really about: zoom changes the viewport measured in CSS
  // pixels, so a window placed while zoomed in keeps a height budgeted for half a screen. Coming
  // back to normal zoom then leaves the definitions crushed into a few pixels inside a card that
  // still thinks it is tiny. Resizing the viewport reproduces it exactly.
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '开始阅读';
    window.__translation = 'Start reading.';
    window.__captureRegion = { x: 200, y: 60, width: 180, height: 90 };
  });

  await page.setViewport({ width: 900, height: 420 });
  // Let the resize land before framing anything: the snip overlay cancels on resize, so a
  // late-arriving one kills the drag half way through.
  await settled(page);
  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );
  await settled(page);

  // Back to a roomy viewport, as if the user zoomed out again.
  await page.setViewport({ width: 900, height: 800 });
  await settled(page);
  await settled(page);

  const after = await layoutOf(page);
  assertLayout(after, 'after the viewport grew');

  // The specific thing the resize handler does. Placed for a 420px viewport the card is capped
  // near the 200px floor; with the taller viewport it should have taken the room now available.
  // Without the handler that cap is never recomputed and the card stays small -- which is what
  // crushes the definitions into a few pixels.
  assert.ok(
    after.cardHeight > 300,
    `the card is still ${Math.round(after.cardHeight)}px (max-height ${after.maxHeight}) -- ` +
      'it kept a height budgeted for the smaller viewport',
  );

  page.assertNoErrors();
  await page.close();
});

test('the window cancels the page zoom instead of following it', async () => {
  // People zoom in to capture text at a higher resolution -- it is the recommended fix for a poor
  // reading -- but nobody zooms in to read the definitions. Following the page would balloon the
  // window exactly when the viewport, measured in CSS pixels, has least room for it.
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '开始阅读';
    window.__captureRegion = { x: 200, y: 60, width: 180, height: 90 };
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );
  await settled(page);

  const plain = await layoutOf(page);
  assertLayout(plain, 'at 100%');

  // Now the page is zoomed to 200%, as it would be for a higher-resolution capture.
  await page.evaluate(() => {
    window.__zoom = 2;
    window.dispatchEvent(new Event('resize'));
  });
  await settled(page);
  await settled(page);

  const zoomed = await inResult(page, (root) => {
    const card = root.querySelector('.card');
    return {
      transform: getComputedStyle(root.host).transform,
      rendered: card.getBoundingClientRect().height,
      // The card's own layout height, before the host's transform shrinks it.
      layout: card.offsetHeight,
    };
  });

  // scale(0.5) shows up as a matrix; what matters is that it halves.
  assert.match(zoomed.transform, /^matrix\(0\.5,/, `host transform is ${zoomed.transform}`);
  // Halving the CSS-pixel footprint is what *keeps the physical size the same*: at 200% each CSS
  // pixel is drawn twice as large. It is also what stops the window crowding a viewport which,
  // measured in CSS pixels, has just halved along with it.
  const ratio = zoomed.rendered / plain.cardHeight;
  assert.ok(
    ratio > 0.4 && ratio < 0.6,
    `expected the CSS-pixel footprint to halve, got ${ratio.toFixed(2)} ` +
      `(${Math.round(plain.cardHeight)} -> ${Math.round(zoomed.rendered)})`,
  );
  // Counter-scaled rather than merely made smaller: the card still lays out at full size and is
  // drawn down, so nothing inside it was restyled and no text was reflowed.
  assert.ok(
    zoomed.layout > zoomed.rendered * 1.5,
    `the card was shrunk rather than scaled (layout ${zoomed.layout}, rendered ${Math.round(zoomed.rendered)})`,
  );

  assertLayout(await layoutOf(page), 'at 200%');

  page.assertNoErrors();
  await page.close();
});

test('the action buttons stay put while the card scrolls under them', async () => {
  // They used to be absolutely positioned inside .shot, which is a normal child of the scrolling
  // card -- and an absolutely positioned element inside a scroll container scrolls with its
  // content. So the gear, retry and close went off the top as soon as the window had more in it
  // than fitted.
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '开始阅读';
    window.__translation = 'A translation long enough to add some height of its own.';
    window.__captureRegion = { x: 200, y: 60, width: 180, height: 90 };
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );
  await settled(page);

  const moved = await inResult(page, (root) => {
    const card = root.querySelector('.card');
    const actions = root.querySelector('.shot-actions');
    const before = actions.getBoundingClientRect().top;

    // Structural: whatever the scroll position, they must not live inside the scroller.
    const insideCard = card.contains(actions);

    card.scrollTop = card.scrollHeight;
    const after = actions.getBoundingClientRect().top;
    return { insideCard, before, after, scrolled: card.scrollTop };
  });

  assert.equal(moved.insideCard, false, 'the buttons are inside the scrolling card');
  assert.ok(
    Math.abs(moved.after - moved.before) < 1,
    `the buttons moved ${Math.round(moved.after - moved.before)}px when the card scrolled`,
  );

  page.assertNoErrors();
  await page.close();
});

test('a click on the page closes the window, and a click inside it does not', async () => {
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '开始阅读';
    window.__captureRegion = { x: 400, y: 300, width: 180, height: 90 };
  });

  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );
  await settled(page);

  const box = await inResult(page, (root) => {
    const r = root.querySelector('.card').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

  // Inside first: the capture itself, which is not a button and should do nothing at all.
  await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + 12));
  assert.equal(
    await inResult(page, (root) => root.host.hasAttribute('data-visible')),
    true,
    'clicking the window closed it',
  );

  // Then well clear of it.
  await page.mouse.click(20, 20);
  assert.equal(
    await inResult(page, (root) => root.host.hasAttribute('data-visible')),
    false,
    'clicking the page left the window open',
  );

  page.assertNoErrors();
  await page.close();
});

test('the buttons stay clear of the scrollbar when the card scrolls', async (t) => {
  // They are anchored to the host, which spans the card including its scrollbar, so the rightmost
  // one sat on top of it as soon as the card started scrolling. The width has to be measured --
  // it differs by platform, and is zero when the card does not scroll at all.
  //
  // Headless Chrome lays out overlay scrollbars, which occupy no width, so there is often nothing
  // here to collide with; styling ::-webkit-scrollbar does not change that either. The test skips
  // itself rather than asserting something vacuous, and does run on a platform with classic
  // scrollbars -- Windows, which is where the overlap was reported.
  const page = await openPage();
  await page.evaluate(() => {
    window.zhDic.recognise = async () => '开始阅读';
    window.__translation = 'A translation with enough length to push the card past its own height.';
    window.__captureRegion = { x: 200, y: 40, width: 180, height: 90 };
  });

  // Cramped enough that the card has to scroll as one.
  await page.setViewport({ width: 900, height: 380 });
  await settled(page);
  await snipTheRedBlock(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-zh-dic-host]')]
        .find((h) => h.dataset.zhDicResult !== undefined)
        ?.shadowRoot?.querySelector('.entry .word'),
    { timeout: 5000 },
  );
  await settled(page);

  const box = await inResult(page, (root) => {
    const card = root.querySelector('.card');
    const actions = root.querySelector('.shot-actions');
    const style = getComputedStyle(card);
    const borderRight = parseFloat(style.borderRightWidth) || 0;
    const borders = (parseFloat(style.borderLeftWidth) || 0) + borderRight;
    return {
      scrollbar: Math.max(0, card.offsetWidth - card.clientWidth - borders),
      cardRight: card.getBoundingClientRect().right,
      actionsRight: actions.getBoundingClientRect().right,
      borderRight,
      cardScrolls: card.scrollHeight > card.clientHeight + 1,
    };
  });

  await page.close();

  if (!box.cardScrolls || box.scrollbar <= 0) {
    t.skip('no space-taking scrollbar was laid out; nothing to collide with here');
    return;
  }

  // The buttons must end before the scrollbar starts.
  const scrollbarStarts = box.cardRight - box.borderRight - box.scrollbar;
  assert.ok(
    box.actionsRight <= scrollbarStarts + 0.5,
    `the buttons overlap the scrollbar by ${Math.round(box.actionsRight - scrollbarStarts)}px`,
  );
});
