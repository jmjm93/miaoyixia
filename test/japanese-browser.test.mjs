// Real options/content/background/offscreen code with local recordings of downloads.
// A fresh browser context per test keeps downloaded packs independent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import { JAPANESE_SOURCES } from '../extension/src/lib/japanese-store.js';
import { archiveFor, fakeModel } from './japanese-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let browser, server, origin;
const requests = [];
before(async () => {
  const executablePath = [process.env.ZH_DIC_BROWSER,
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean).find(existsSync);
  assert.ok(executablePath, 'Set ZH_DIC_BROWSER to a Chromium browser');
  server = createServer(async (req, res) => {
    requests.push(req.url);
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><p id="ja" style="font:32px sans-serif">食べました。ありがとう。コーヒー。</p><p id="zh">你好</p>');
      return;
    }
    try {
      const path = decodeURIComponent(req.url.split('?')[0]).slice(1);
      const data = await readFile(join(root, path));
      res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css' }[extname(path)] ?? 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function open({ options = false, permit = true, brokenModel = false, realModels = false, fullDictionary = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  const downloads = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const name = Object.keys(JAPANESE_SOURCES).find((name) => request.url() === JAPANESE_SOURCES[name]);
    if (!name) return request.continue();
    downloads.push(name);
    const body = name === 'dictionary' ? (fullDictionary ? await readFile(join(root, 'vendor/japanese/dictionary.tgz')) : archiveFor()) : brokenModel ? Buffer.from('<html>not a model</html>')
      : realModels ? await readFile(join(root, 'vendor/japanese', `${name}.traineddata`)) : fakeModel();
    await request.respond({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/octet-stream', body });
  });
  await page.evaluateOnNewDocument((origin, permit) => {
    window.__store = {};
    window.__permissionRequests = [];
    window.__granted = false;
    const changes = [];
    const messages = [];
    let background;
    let offscreen = false;
    const event = { addListener() {} };
    window.chrome = {
      i18n: { getUILanguage: () => 'en' },
      storage: {
        sync: {
          get: async (defaults) => ({ ...defaults, ...window.__store }),
          set: async (patch) => {
            Object.assign(window.__store, patch);
            const diff = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { newValue: value }]));
            for (const listener of changes) await listener(diff, 'sync');
          },
        },
        onChanged: { addListener: (listener) => changes.push(listener) },
      },
      permissions: {
        contains: async () => window.__granted,
        request: async (request) => { window.__permissionRequests.push(request); window.__granted = permit; return permit; },
        onRemoved: event,
      },
      action: { setIcon: async () => {}, setTitle: async () => {}, setBadgeText: async () => {}, onClicked: event },
      contextMenus: { removeAll: (cb) => cb(), create() {}, update: async () => {}, onClicked: event },
      tabs: { getZoom: async () => 1 },
      offscreen: {
        hasDocument: async () => offscreen,
        createDocument: async () => { await import(`${origin}/extension/src/offscreen/offscreen.js`); offscreen = true; },
      },
      runtime: {
        getURL: (path) => `${origin}/extension/${path}`,
        onMessage: { addListener: (listener) => messages.push(listener) },
        onInstalled: event, onStartup: event,
        sendMessage: async (message) => {
          background ??= import(`${origin}/extension/src/background/service-worker.js`);
          await background;
          return new Promise((resolve, reject) => {
            let pending = false, answered = false;
            for (const listener of messages) {
              const async = listener(message, {}, (response) => { answered = true; resolve(response); });
              if (answered) return;
              if (async === true) pending = true;
            }
            if (!pending) reject(new Error(`No handler for ${message.type}`));
          });
        },
      },
    };
  }, origin, permit);
  await page.goto(options ? `${origin}/extension/src/options/options.html` : origin);
  if (options) await page.waitForFunction(() => document.body.dataset.ready !== undefined);
  return { page, context, downloads, errors };
}

async function install(page) {
  await page.evaluate(async (origin) => {
    const pack = await import(`${origin}/extension/src/lib/japanese-store.js`);
    await chrome.permissions.request({ origins: pack.JAPANESE_ORIGINS });
    await pack.downloadJapanese();
    await chrome.runtime.sendMessage({ type: 'japaneseChanged' });
    await chrome.storage.sync.set({ japaneseEnabled: true, lookupLanguage: 'ja' });
  }, origin);
}

test('options start in Chinese without Japanese network requests; refusal leaves it disabled', async () => {
  const { page, context, downloads, errors } = await open({ options: true, permit: false });
  try {
    assert.deepEqual(downloads, []);
    assert.equal(await page.$eval('#japaneseEnabled', (el) => el.checked), false);
    assert.equal(await page.$eval('#lookupLanguage', (el) => el.value), 'zh');
    assert.equal(await page.$eval('#lookupLanguage', (el) => el.disabled), true);
    await page.click('#japaneseEnabled');
    await page.waitForFunction(() => document.querySelector('#japaneseStatus').textContent.includes('Allow access'));
    assert.deepEqual(downloads, []);
    assert.equal(await page.$eval('#japaneseEnabled', (el) => el.checked), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Automatic uses sentence context, preserves forced languages and is disabled with the add-on', async () => {
  const { page, context, downloads, errors } = await open({ options: true });
  try {
    await install(page);
    await page.waitForFunction(() => !document.querySelector('#lookupLanguage').disabled);
    await page.select('#lookupLanguage', 'auto');
    const results = await page.evaluate(async () => {
      const lookup = (text, sentence) => chrome.runtime.sendMessage({ type: 'lookup', text, sentence });
      const japanese = await lookup('学校', '私は学校に行きます。');
      const chinese = await lookup('学校', '他是学校的学生。');
      const ambiguous = await lookup('学校', '学校');
      const kana = await lookup('ありがとう', 'ありがとう。');
      await chrome.storage.sync.set({ lookupLanguage: 'zh' });
      const forcedChinese = await lookup('学校', '私は学校に行きます。');
      await chrome.storage.sync.set({ lookupLanguage: 'ja' });
      const forcedJapanese = await lookup('学校', '他是学校的学生。');
      return { japanese, chinese, ambiguous, kana, forcedChinese, forcedJapanese };
    });
    const first = (response) => response.result.candidates[0].cards[0];
    assert.equal(first(results.japanese).language, 'ja');
    assert.notEqual(first(results.chinese).language, 'ja');
    assert.notEqual(first(results.ambiguous).language, 'ja');
    assert.equal(first(results.kana).language, 'ja');
    assert.notEqual(first(results.forcedChinese).language, 'ja');
    assert.equal(first(results.forcedJapanese).language, 'ja');
    await page.click('#japaneseEnabled');
    await page.waitForFunction(() => document.querySelector('#lookupLanguage').disabled);
    assert.equal(await page.$eval('#lookupLanguage', (el) => el.value), 'zh');
    assert.equal(downloads.length, 3);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('enabling downloads once, Chinese remains selected, and disable/re-enable reuses local data', async () => {
  const { page, context, downloads, errors } = await open({ options: true });
  try {
    await page.click('#japaneseEnabled');
    await page.waitForFunction(() => window.__store.japaneseEnabled === true && !document.querySelector('#japaneseEnabled').disabled);
    assert.deepEqual(downloads, ['dictionary', 'jpn', 'jpn_vert']);
    assert.equal(await page.$eval('#lookupLanguage', (el) => el.value), 'zh');
    await page.select('#lookupLanguage', 'ja');
    await page.waitForFunction(() => window.__store.lookupLanguage === 'ja');
    assert.equal(await page.$eval('#ocrScript', (el) => el.closest('.row').hidden), true);
    await page.click('#japaneseEnabled');
    await page.waitForFunction(() => window.__store.lookupLanguage === 'zh');
    await page.click('#japaneseEnabled');
    await page.waitForFunction(() => window.__store.japaneseEnabled === true && !document.querySelector('#japaneseEnabled').disabled);
    assert.equal(downloads.length, 3);
    await page.click('#japaneseRemove');
    await page.waitForFunction(() => document.querySelector('#japaneseStatus').textContent === 'Not downloaded');
    assert.equal(await page.evaluate(() => window.__store.japaneseEnabled), false);
    assert.equal(await page.evaluate(async (origin) => (await import(`${origin}/extension/src/lib/japanese-store.js`)).japaneseReady(), origin), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a failed model download cannot enable Japanese or install a partial pack', async () => {
  const { page, context, downloads, errors } = await open({ options: true, brokenModel: true });
  try {
    await page.click('#japaneseEnabled');
    await page.waitForFunction(() => document.querySelector('#japaneseStatus').textContent.includes('Invalid Japanese OCR model'));
    assert.equal(await page.$eval('#japaneseEnabled', (el) => el.checked), false);
    assert.equal(await page.evaluate(async (origin) => (await import(`${origin}/extension/src/lib/japanese-store.js`)).japaneseReady(), origin), false);
    assert.deepEqual(downloads, ['dictionary', 'jpn']);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('synced Japanese preferences without a local pack use Chinese and never download automatically', async () => {
  const { page, context, downloads, errors } = await open();
  try {
    await page.evaluate(() => chrome.storage.sync.set({ japaneseEnabled: true, lookupLanguage: 'ja' }));
    const result = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'lookup', text: '你好' }));
    assert.equal(result.ok, true);
    assert.equal(result.result.candidates[0].cards[0].headword, '你好');
    assert.deepEqual(downloads, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('real worker lookups and DOM hover render kana, inflections and no Chinese action buttons offline', async () => {
  const { page, context, downloads, errors } = await open();
  try {
    await install(page);
    await page.evaluate(async (origin) => {
      const manifest = await (await fetch(`${origin}/extension/manifest.json`)).json();
      for (const path of manifest.content_scripts[0].js) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = `${origin}/extension/${path}`;
          script.onload = resolve; script.onerror = reject; document.head.append(script);
        });
      }
    }, origin);
    await page.waitForFunction(() => document.querySelector('[data-zh-dic-host]'));
    const rect = await page.$eval('#ja', (el) => {
      const range = document.createRange(); range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, 1);
      const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.move(rect.x, rect.y);
    await page.keyboard.down('Shift'); await page.keyboard.up('Shift');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-zh-dic-host]')].some((el) => el.shadowRoot?.querySelector('.word')?.textContent === '食べる'));
    const state = await page.evaluate(() => {
      const root = [...document.querySelectorAll('[data-zh-dic-host]')].find((el) => el.shadowRoot?.querySelector('.word'))?.shadowRoot;
      return { reading: root.querySelector('.pinyin').textContent, senses: root.querySelector('.senses').textContent, actions: root.querySelectorAll('.speak, .anki-add').length,
        highlighted: [...CSS.highlights.get('zh-dic-match')][0].toString() };
    });
    assert.equal(state.reading, 'たべる'); assert.match(state.senses, /to eat/); assert.equal(state.actions, 0);
    assert.equal(state.highlighted, '食べました', 'highlight the inflection, not the shorter dictionary form');
    const kana = await page.evaluate(() => {
      const node = document.querySelector('#ja').firstChild;
      const words = ['ありがとう', 'コーヒー'];
      return words.map((word) => {
        const offset = node.data.indexOf(word);
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        return window.zhDic.resolveAtPoint(rect.x + rect.width / 2, rect.y + rect.height / 2, true)?.word;
      });
    });
    assert.deepEqual(kana, ['ありがとう', 'コーヒー']);
    const reading = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'read', text: '私はコーヒーを食べました。' }));
    assert.equal(reading.ok, true);
    assert.deepEqual(reading.result.tokens.map((token) => token.text), ['私', 'は', 'コーヒー', 'を', '食べました', '。']);
    assert.equal(reading.result.tokens[4].candidates[0].cards[0].headword, '食べる');
    await page.evaluate(() => chrome.storage.sync.set({ japaneseEnabled: false, lookupLanguage: 'zh' }));
    const chinese = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'lookup', text: '你好' }));
    assert.equal(chinese.result.candidates[0].cards[0].headword, '你好');
    assert.equal(downloads.length, 3, 'hovering and reading must not fetch dictionary data');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

const haveModels = ['jpn', 'jpn_vert'].every((model) => existsSync(join(root, 'vendor/japanese', `${model}.traineddata`)));
test('the full pinned dictionary installs and answers Japanese lookups offline', {
  skip: haveModels && existsSync(join(root, 'vendor/japanese/dictionary.tgz')) ? false : 'run node tools/verify-japanese.mjs', timeout: 60000,
}, async () => {
  const { page, context, downloads, errors } = await open({ realModels: true, fullDictionary: true });
  try {
    await install(page);
    const result = await page.evaluate(async (origin) => {
      const pack = await import(`${origin}/extension/src/lib/japanese-store.js`);
      return {
        info: await pack.japaneseInfo(),
        match: await chrome.runtime.sendMessage({ type: 'lookup', text: '食べました' }),
      };
    }, origin);
    assert.equal(result.info.entries, 218863);
    assert.equal(result.match.result.candidates[0].cards[0].headword, '食べる');
    assert.equal(result.match.result.candidates[0].cards[0].reading, 'たべる');
    assert.deepEqual(downloads, ['dictionary', 'jpn', 'jpn_vert']);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
test('actual Japanese OCR reads downloaded models through the offscreen code without model network fetches', {
  skip: haveModels ? false : 'run node tools/verify-japanese.mjs to download developer OCR fixtures', timeout: 60000,
}, async () => {
  const { page, context, downloads, errors } = await open({ realModels: true });
  try {
    await install(page);
    const before = requests.length;
    const readings = await page.evaluate(async () => {
      const results = [];
      for (const vertical of [false, true]) {
        await chrome.storage.sync.set({ ocrOrientation: vertical ? 'vertical' : 'horizontal' });
        const canvas = document.createElement('canvas');
        canvas.width = vertical ? 140 : 640; canvas.height = vertical ? 520 : 140;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'black'; ctx.font = '44px "Yu Gothic", "Meiryo", sans-serif';
        if (vertical) [...'日本語'].forEach((char, i) => ctx.fillText(char, 40, 85 + i * 64));
        else ctx.fillText('私は学校に行きます', 20, 90);
        results.push(await chrome.runtime.sendMessage({ type: 'recognise', dataUrl: canvas.toDataURL('image/png') }));
      }
      await chrome.storage.sync.set({ lookupLanguage: 'auto', ocrOrientation: 'horizontal' });
      for (const text of ['私は学校に行きます', '这是我的学校']) {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 140;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 640, 140);
        ctx.fillStyle = 'black'; ctx.font = '44px "Yu Gothic", "Meiryo", sans-serif';
        ctx.fillText(text, 20, 90);
        results.push(await chrome.runtime.sendMessage({ type: 'recognise', dataUrl: canvas.toDataURL('image/png') }));
      }
      return results;
    });
    for (const reading of readings) assert.equal(reading.ok, true, reading.error);
    assert.equal(readings[0].result.text, '私は学校に行きます');
    assert.equal(readings[1].result.text, '日本語');
    assert.equal(readings[2].result.text, '私は学校に行きます');
    assert.equal(readings[2].result.language, 'ja');
    assert.equal(readings[3].result.language, 'zh');
    assert.equal(downloads.length, 3);
    assert.ok(!requests.slice(before).some((url) => /jpn(?:_vert)?\.traineddata/.test(url)), 'OCR tried fetching a model instead of reading local data');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Japanese export and duplicate checks use Yomi and never request Mandarin audio', async () => {
  const { page, context, errors } = await open();
  try {
    const result = await page.evaluate(async () => {
      const calls = [];
      const originalFetch = window.fetch;
      window.fetch = async (url, init) => {
        if (url !== 'http://127.0.0.1:8765') throw new Error('Unexpected export fetch: ' + url);
        const { action, params } = JSON.parse(init.body);
        calls.push({ action, params });
        const answers = {
          deckNames: ['Japanese Mining'], modelNames: ['Yomi'],
          modelFieldNames: ['Expression', 'Meaning', 'Reading', 'Furigana', 'Audio', 'Manual examples', 'Examples', 'asdf'],
          canAddNotesWithErrorDetail: [{ canAdd: false, error: 'duplicate' }], addNote: 123
        };
        return { ok: true, json: async () => ({ result: answers[action], error: null }) };
      };
      try {
        const card = { language: 'ja', headword: '食べる', reading: 'たべる', hovered: '食べました',
          senses: ['to eat'], sentence: '食べました。' };
        // Even a manually configured audio token must not invoke Chinese providers.
        window.__store.japaneseAnkiFields = { Expression: 'headword', Reading: 'reading', Audio: 'audio' };
        const inspect = await chrome.runtime.sendMessage({ type: 'ankiInspect', cards: [card] });
        const add = await chrome.runtime.sendMessage({ type: 'ankiAdd', card });
        return { inspect, add, calls };
      } finally { window.fetch = originalFetch; }
    });
    assert.equal(result.inspect.ok, true);
    assert.equal(result.inspect.result.states[0].duplicate, true);
    assert.equal(result.add.ok, true, result.add.error);
    assert.equal(result.add.result.deck, 'Japanese Mining');
    assert.equal(result.add.result.audio, false);
    const inspected = result.calls.find(c => c.action === 'canAddNotesWithErrorDetail').params.notes[0];
    const added = result.calls.find(c => c.action === 'addNote').params.note;
    assert.equal(added.modelName, 'Yomi');
    assert.equal(added.fields.Reading, 'たべる');
    assert.equal(added.fields.Audio, '');
    assert.deepEqual(added.fields, inspected.fields);
    assert.deepEqual(added.options, inspected.options);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
