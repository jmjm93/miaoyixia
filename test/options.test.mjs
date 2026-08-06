// Tests the options page's voice-dependent logic: which audio choices are offered, which
// is shown, and — importantly — what gets written to storage.
//
// The persistence rules are the subtle part. 'voice' cannot work without an installed voice,
// so it is corrected in storage. 'auto' already falls back to a recording, so it is only
// *displayed* as the recording option and left stored as-is; persisting that would strand the
// user on recordings-only after they install a voice.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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
const ZH_VOICE = { name: 'Microsoft Huihui', lang: 'zh-CN', localService: true };

let browser;
let server;
let origin;

before(async () => {
  const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
  assert.ok(executablePath, 'No Chromium-family browser found. Set ZH_DIC_BROWSER=<path>.');

  server = createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url).slice(1);
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

/** Load the real options page with a stubbed storage and voice list, and report its state. */
async function loadOptions({ audio, voices }) {
  const page = await browser.newPage();
  const failures = [];
  page.on('pageerror', (e) => failures.push(e.message));

  await page.evaluateOnNewDocument(`
    window.__store = { audio: ${JSON.stringify(audio)} };
    window.__set = [];
    // speechSynthesis is a read-only accessor on Window, so it needs defineProperty.
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { getVoices: () => ${JSON.stringify(voices)}, addEventListener() {} },
    });
    window.chrome = {
      storage: {
        sync: {
          get: async (defaults) => ({ ...defaults, ...window.__store }),
          set: async (patch) => { window.__set.push(patch); Object.assign(window.__store, patch); },
        },
        // The page mirrors external edits (e.g. from the toolbar button) through this.
        onChanged: { addListener() {} },
      },
      // getMeta is irrelevant here; failing it exercises the "no dictionary built" path too.
      runtime: { sendMessage: async () => ({ ok: false, error: 'not needed' }) },
    };
  `);

  await page.goto(`${origin}/extension/src/options/options.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('voiceStatus').textContent !== 'Checking for Chinese voices…');

  const state = await page.evaluate(() => {
    const select = document.getElementById('audio');
    return {
      selected: select.value,
      disabled: [...select.options].filter((o) => o.disabled).map((o) => o.value),
      persisted: window.__set,
      helpVisible: !document.getElementById('voiceHelp').hidden,
      statusVisible: !document.getElementById('voiceStatus').hidden,
      status: document.getElementById('voiceStatus').textContent,
    };
  });

  assert.deepEqual(failures, [], 'unexpected page errors');
  await page.close();
  return state;
}

test('with no Chinese voice, the voice-dependent choices are disabled', async () => {
  const state = await loadOptions({ audio: 'auto', voices: [] });
  assert.deepEqual(state.disabled, ['auto', 'voice']);
  assert.equal(state.selected, 'recording', 'falls back to what will actually happen');
});

test('a stored "auto" is not rewritten, so installing a voice later restores it', async () => {
  const state = await loadOptions({ audio: 'auto', voices: [] });
  assert.deepEqual(state.persisted, [], 'auto already falls back; nothing needs saving');
});

test('a stored "voice" is corrected, because it cannot work at all', async () => {
  const state = await loadOptions({ audio: 'voice', voices: [] });
  assert.deepEqual(state.persisted, [{ audio: 'recording' }]);
  assert.equal(state.selected, 'recording');
});

test('the install instructions are shown and opened when no voice is found', async () => {
  const state = await loadOptions({ audio: 'auto', voices: [] });
  assert.ok(state.statusVisible);
  assert.ok(state.helpVisible, 'the help must show precisely when the options are greyed out');
  assert.match(state.status, /No Chinese voice is installed/);
  assert.match(state.status, /better option of the two/, 'should recommend the voice over Commons');
});

test('"no audio" hides the voice guidance entirely', async () => {
  const state = await loadOptions({ audio: 'off', voices: [] });
  assert.equal(state.selected, 'off');
  assert.equal(state.statusVisible, false);
  assert.equal(state.helpVisible, false);
  assert.deepEqual(state.persisted, [], 'a deliberate "off" is left alone');
});

test('with a Chinese voice, every choice is offered and the stored one is kept', async () => {
  for (const audio of ['auto', 'voice', 'recording', 'off']) {
    const state = await loadOptions({ audio, voices: [ZH_VOICE] });
    assert.deepEqual(state.disabled, [], `nothing disabled for ${audio}`);
    assert.equal(state.selected, audio, `${audio} preserved`);
    assert.deepEqual(state.persisted, [], `${audio} not rewritten`);
  }
});

test('a detected voice is named, and the install help stays shut', async () => {
  const state = await loadOptions({ audio: 'auto', voices: [ZH_VOICE] });
  assert.match(state.status, /Microsoft Huihui \[zh-CN\]/);
  assert.equal(state.helpVisible, false);
});

test('a stored "recording" is untouched whether or not a voice exists', async () => {
  for (const voices of [[], [ZH_VOICE]]) {
    const state = await loadOptions({ audio: 'recording', voices });
    assert.equal(state.selected, 'recording');
    assert.deepEqual(state.persisted, []);
  }
});
