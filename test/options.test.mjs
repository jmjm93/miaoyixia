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
import { CATALOGUE } from '../extension/src/lib/i18n.js';
import { GLOSS_SOURCES } from '../extension/src/lib/gloss-store.js';

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

/**
 * Open the real options page against a stubbed storage and voice list.
 *
 * storage.onChanged listeners are collected on window.__onChanged rather than dropped, so a test
 * can drive the "a setting changed elsewhere" path -- which is how the language switch is applied.
 */
async function openOptions({ audio, voices, store = {} }) {
  const page = await browser.newPage();
  const failures = [];
  page.on('pageerror', (e) => failures.push(e.message));

  await page.evaluateOnNewDocument(`
    window.__store = { audio: ${JSON.stringify(audio)}, ...${JSON.stringify(store)} };
    window.__set = [];
    window.__onChanged = [];
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
        onChanged: { addListener: (fn) => window.__onChanged.push(fn) },
      },
      // getMeta is irrelevant here; failing it exercises the "no dictionary built" path too.
      runtime: { sendMessage: async () => ({ ok: false, error: 'not needed' }) },
      // Refused, so the Anki rows render from the configured mapping without reaching Anki --
      // which is enough to see the field-token labels in the right language.
      permissions: { contains: async () => false, request: async () => false },
    };
  `);

  await page.goto(`${origin}/extension/src/options/options.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready !== undefined);
  return { page, failures };
}

/** Load the page and report the audio-source state it settled on. */
async function loadOptions(options) {
  const { page, failures } = await openOptions(options);

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

// --- language ------------------------------------------------------------------

/** The text of the labelled controls, so a translation can be checked without ids everywhere. */
const READ_LABELS = `({
  lang: document.documentElement.lang,
  title: document.title,
  tagline: document.querySelector('.lede').textContent,
  enabled: document.querySelector('#enabled + span').textContent,
  language: document.querySelector('[data-i18n="uiLanguage"]').textContent,
  pronunciation: document.querySelector('[data-i18n="pronunciation"]').textContent,
  noKey: document.querySelector('#triggerKey option[value="none"]').textContent,
  audioHint: document.getElementById('audioHint').textContent,
  voiceStatus: document.getElementById('voiceStatus').textContent,
  firstToken: document.querySelector('#ankiFieldsTable select option').textContent,
  voiceHelpNote: document.getElementById('voiceHelpNote').textContent,
})`;

test('the page renders in Spanish when that is the stored language', async () => {
  const { page, failures } = await openOptions({
    audio: 'auto',
    voices: [],
    store: { uiLanguage: 'es', ankiEnabled: true },
  });

  const text = await page.evaluate(READ_LABELS);

  // Asserted against the catalogue rather than against literal copy. What is under test is
  // that the Spanish branch was taken -- and since every key below differs between en and es,
  // rendering English still fails. Pinning the exact wording instead would mean every tweak
  // to a translation breaks a test that has nothing to do with the wording.
  assert.equal(text.lang, 'es', '<html lang> should follow the chosen language');
  assert.equal(text.title, CATALOGUE.es.optionsTitle);
  assert.equal(text.tagline, CATALOGUE.es.tagline);
  assert.equal(text.enabled, CATALOGUE.es.enabled);
  assert.equal(text.language, CATALOGUE.es.uiLanguage);
  assert.equal(text.pronunciation, CATALOGUE.es.pronunciation);
  assert.equal(text.noKey, CATALOGUE.es.noKey);

  // Strings assembled in JS rather than replaced in the markup.
  // Shows the recording hint, not the "auto" one: with no voice installed the select is
  // displayed as the option that will actually be used. Either way it comes from AUDIO_HINTS.
  assert.equal(text.audioHint, CATALOGUE.es.audioHintRecording);
  assert.match(text.voiceStatus, /No hay ninguna voz en chino/, 'live voice status');
  assert.equal(text.firstToken, CATALOGUE.es.tokenNone, 'the Anki field tokens are built in JS');

  // The count itself comes from CC-CEDICT and changes with every upstream release, so assert
  // the *formatting* instead: Spanish groups thousands with a period, English with a comma.
  assert.match(text.voiceHelpNote, /\d{1,3}(\.\d{3})+ entradas/, 'Spanish thousands separator');

  assert.deepEqual(failures, [], 'unexpected page errors');
  await page.close();
});

test('changing the language repaints the page without a reload', async () => {
  const { page, failures } = await openOptions({
    audio: 'auto',
    voices: [],
    store: { uiLanguage: 'es', ankiEnabled: true },
  });

  // Exactly what the storage listener receives when the setting is changed anywhere.
  await page.evaluate(() => {
    window.__store.uiLanguage = 'en';
    for (const fn of window.__onChanged) fn({ uiLanguage: { newValue: 'en' } }, 'sync');
  });
  await page.waitForFunction(() => document.documentElement.lang === 'en');

  const text = await page.evaluate(READ_LABELS);
  assert.equal(text.enabled, CATALOGUE.en.enabled);
  assert.equal(text.pronunciation, CATALOGUE.en.pronunciation);
  assert.equal(text.firstToken, CATALOGUE.en.tokenNone, 'the field rows must be rebuilt, not left stale');
  // These carry a placeholder in the markup, so the repaint must put the real answer back
  // rather than leaving "Checking for Chinese voices…" behind.
  assert.match(text.voiceStatus, /No Chinese voice is installed/);
  assert.match(text.voiceHelpNote, /\d{1,3}(,\d{3})+ entries/, 'English thousands separator');

  assert.deepEqual(failures, [], 'unexpected page errors');
  await page.close();
});

// --- definition languages ----------------------------------------------------
//
// The list is always on screen, so it has to be right before anything is downloaded: the
// bundled language offers no action, a downloadable one says what it would cost you, and the
// row marked active is where definitions are *actually* coming from — which is not the same as
// the picker's value while a download is pending.

const READ_GLOSS_LIST = `Array.from(document.querySelectorAll('#glossList li')).map((li) => ({
  lang: li.dataset.lang,
  state: li.dataset.state,
  active: li.hasAttribute('data-active'),
  name: li.querySelector('.name').textContent,
  status: li.querySelector('.state').textContent,
  button: li.querySelector('button')?.textContent ?? null,
}))`;

test('every definition language is listed, downloaded or not', async () => {
  const { page, failures } = await openOptions({ audio: 'auto', voices: [] });
  const rows = await page.evaluate(READ_GLOSS_LIST);

  assert.deepEqual(
    rows.map((r) => r.lang),
    ['en', 'es'],
    'the bundled language and every downloadable one',
  );

  const [en, es] = rows;
  assert.equal(en.state, 'bundled');
  assert.equal(en.status, CATALOGUE.en.glossBundled);
  assert.equal(en.button, null, 'nothing to download or remove for the bundled language');
  assert.equal(en.active, true, 'English is the default');

  // The stub refuses the permission, so the row should say why rather than claim it is merely
  // absent — that is the difference between "click to get it" and "you must allow this first".
  assert.equal(es.state, 'missing');
  assert.equal(es.status, CATALOGUE.en.glossNeedsPermission);
  assert.equal(es.button, CATALOGUE.en.glossDownload);
  assert.equal(es.active, false);

  assert.deepEqual(failures, [], 'unexpected page errors');
  await page.close();
});

test('the active row follows the stored language, not the download state', async () => {
  // Spanish selected but never downloaded: the picker says Spanish, lookups still answer in
  // English, and the list must not imply the data is present.
  const { page, failures } = await openOptions({
    audio: 'auto',
    voices: [],
    store: { glossLanguage: 'es' },
  });

  const rows = await page.evaluate(READ_GLOSS_LIST);
  assert.equal(await page.evaluate(() => document.getElementById('glossLanguage').value), 'es');
  assert.equal(rows.find((r) => r.lang === 'es').active, true);
  assert.equal(rows.find((r) => r.lang === 'en').active, false);
  assert.equal(rows.find((r) => r.lang === 'es').state, 'missing', 'selected is not downloaded');

  assert.deepEqual(failures, [], 'unexpected page errors');
  await page.close();
});

test('the language list is translated with the rest of the page', async () => {
  const { page, failures } = await openOptions({
    audio: 'auto',
    voices: [],
    store: { uiLanguage: 'es' },
  });

  const rows = await page.evaluate(READ_GLOSS_LIST);
  assert.equal(rows[0].status, CATALOGUE.es.glossBundled);
  assert.equal(rows[1].button, CATALOGUE.es.glossDownload);
  // Language names stay in their own language, as everywhere else that lists them.
  assert.equal(rows[1].name, 'Español');

  assert.deepEqual(failures, [], 'unexpected page errors');
  await page.close();
});

/**
 * Put a downloaded layer in IndexedDB, as gloss-store would after a real download.
 *
 * Only the meta record matters here — the list reads that, not the shards. Written through a
 * page on the same origin so it lands in the store the options page will open.
 */
async function seedGloss(page, lang, record) {
  await page.evaluate(
    async (lang, record) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('zh-gloss', 1);
        request.onupgradeneeded = () => {
          const created = request.result;
          if (!created.objectStoreNames.contains('shards')) created.createObjectStore('shards');
          if (!created.objectStoreNames.contains('meta')) created.createObjectStore('meta');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(record, lang);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    lang,
    record,
  );
}

/** Leaving a seeded layer behind would make every other test see it as downloaded. */
async function wipeGloss(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('zh-gloss');
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      }),
  );
}

test('a downloaded layer reports its size, and cannot be removed while in use', async () => {
  const { page, failures } = await openOptions({
    audio: 'auto',
    voices: [],
    store: { glossLanguage: 'es' },
  });
  await seedGloss(page, 'es', {
    entries: 124349,
    version: GLOSS_SOURCES.es.version,
    downloadedAt: '2026-08-08T10:00:00.000Z',
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready !== undefined);

  const es = (await page.evaluate(READ_GLOSS_LIST)).find((r) => r.lang === 'es');
  assert.equal(es.state, 'ready');
  assert.match(es.status, /124,349/, 'reports what is actually stored');
  assert.equal(es.button, CATALOGUE.en.glossRemove);

  // Removing the layer the definitions come from would drop every lookup back to English while
  // the picker still said Spanish — a state indistinguishable from a bug.
  const remove = await page.evaluate(
    () => {
      const button = document.querySelector("#glossList li[data-lang='es'] button");
      return { disabled: button.disabled, title: button.title };
    },
  );
  assert.equal(remove.disabled, true);
  assert.equal(remove.title, CATALOGUE.en.glossRemoveActive, 'says how to unblock it');

  await wipeGloss(page);
  assert.deepEqual(failures, [], 'unexpected page errors');
  await page.close();
});

test('a downloaded layer that is not in use can be removed', async () => {
  const { page, failures } = await openOptions({ audio: 'auto', voices: [] }); // English selected
  await seedGloss(page, 'es', {
    entries: 124349,
    version: GLOSS_SOURCES.es.version,
    downloadedAt: '2026-08-08T10:00:00.000Z',
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready !== undefined);

  const disabled = await page.evaluate(
    () => document.querySelector("#glossList li[data-lang='es'] button").disabled,
  );
  assert.equal(disabled, false, 'nothing depends on it, so it is free to go');

  await wipeGloss(page);
  assert.deepEqual(failures, [], 'unexpected page errors');
  await page.close();
});
