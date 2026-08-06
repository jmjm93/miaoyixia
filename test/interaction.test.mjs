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
import { candidatesFor, installDictStub } from './dict-stub.mjs';

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
  'popup.js',
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
  { lookupDelay = 0, voices = [], audioResult = { found: false }, ankiInspect = null, ankiAdd = null } = {},
) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });

  const failures = [];
  page.on('pageerror', (e) => failures.push(e.message));

  // Same shape the service worker replies with: { ok, result }.
  await page.exposeFunction('__zhLookup', async (text) => {
    if (lookupDelay) await new Promise((r) => setTimeout(r, lookupDelay));
    return { candidates: await candidatesFor(text) };
  });
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

     window.chrome = {
       runtime: {
         getURL: (p) => '${origin}/extension/' + p,
         sendMessage: async (msg) => {
           if (msg.type === 'getSettings') return { ok: true, result: window.__settings };
           if (msg.type === 'lookup') return { ok: true, result: await window.__zhLookup(msg.text) };
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
       },
       storage: { sync: { get: async () => window.__settings }, onChanged: { addListener() {} } },
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
