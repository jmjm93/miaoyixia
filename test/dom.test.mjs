// Browser tests for the parts that need real layout: resolving the pointer to a
// character, and reading a word forward across inline markup.
//
// These inject the content scripts into a page rather than loading the packaged
// extension, because current Chrome stable refuses the --load-extension switch. The code
// under test is the same file the extension ships, and resolveAtPoint() takes explicit
// viewport coordinates, so nothing meaningful is stubbed out.
//
// Needs a local Chromium-family browser. Override the binary with ZH_DIC_BROWSER=<path>.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { candidatesFor, installDictStub } from './dict-stub.mjs';

installDictStub();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = join(root, 'test', 'screenshots');

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

let browser;
let page;
let server;
let origin;

before(async () => {
  const executablePath = CANDIDATE_BROWSERS.find((p) => existsSync(p));
  assert.ok(executablePath, `No Chromium-family browser found. Set ZH_DIC_BROWSER=<path>.`);
  await mkdir(shotDir, { recursive: true });

  // Content scripts and shadow-root stylesheets both misbehave on file://, so serve
  // the fixture and the real popup.css over http.
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
  page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });
  page.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));

  await page.goto(`${origin}/`, { waitUntil: 'load' });

  // popup.js only touches chrome.runtime.getURL, to find its stylesheet.
  await page.evaluateOnNewDocument(`window.chrome = { runtime: { getURL: (p) => '${origin}/extension/' + p } };`);
  await page.reload({ waitUntil: 'load' });

  for (const file of ['text-at-point.js', 'popup.js']) {
    await page.addScriptTag({ content: await readFile(join(root, 'extension/src/content', file), 'utf8') });
  }

  // Locate the nth character of an element's rendered text and return its centre point,
  // walking text nodes the same way the code under test does so ruby annotations and
  // right-aligned text both land where a real pointer would.
  await page.evaluate(() => {
    window.pointAtChar = (selector, index) => {
      const el = document.querySelector(selector);
      // caretRangeFromPoint only resolves coordinates inside the visible viewport, so
      // the target has to be scrolled into view before its rect is meaningful.
      el.scrollIntoView({ block: 'center' });

      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (seen + node.data.length <= index) {
          seen += node.data.length;
          continue;
        }
        const offset = index - seen;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const r = range.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      throw new Error(`${selector} has fewer than ${index + 1} characters`);
    };
  });
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** Resolve a hover and return only the serialisable parts. */
function resolve(selector, index) {
  return page.evaluate(
    ([sel, i]) => {
      const { x, y } = window.pointAtChar(sel, i);
      const hit = globalThis.zhDic.resolveAtPoint(x, y);
      if (!hit) return null;
      return { word: hit.word, sentence: hit.sentence, positions: hit.positions.length };
    },
    [selector, index],
  );
}

test('reads a word forward from the hovered character', async () => {
  const hit = await resolve('#plain', 4); // 中 in 我喜欢吃中国菜。
  assert.equal(hit.word, '中国菜');
  assert.equal(hit.sentence, '我喜欢吃中国菜。');
});

test('stops at punctuation rather than running past it', async () => {
  const hit = await resolve('#plain', 0); // 我喜欢吃中国菜。
  assert.equal(hit.word, '我喜欢吃中国菜');
});

test('reads across inline markup that splits a word', async () => {
  // 中<span>国</span>菜 -- reading only the hovered text node would return just 中.
  const hit = await resolve('#inline-split', 4);
  assert.equal(hit.word, '中国菜');
});

test('handles traditional characters', async () => {
  const hit = await resolve('#traditional', 9); // 中 in 我喜歡喝茶，也喜歡中國菜。
  assert.equal(hit.word, '中國菜');
});

test('ignores pinyin in ruby annotations', async () => {
  const hit = await resolve('#ruby', 0);
  assert.equal(hit.word, '中国菜很好吃');
});

test('reads long words up to the dictionary maximum', async () => {
  const hit = await resolve('#long', 0);
  assert.equal(hit.word, '中华人民共和国成立于一九四九年');
});

test('does not read across a block boundary', async () => {
  // 中国<div>菜</div> -- 菜 is a separate visual run, so it cannot continue the word.
  const hit = await resolve('#blocks', 0);
  assert.equal(hit.word, '中国');
});

test('resolves right-aligned text', async () => {
  const hit = await resolve('#edge', 0);
  assert.equal(hit.word, '这个词在右边');
});

test('returns nothing for non-Chinese text', async () => {
  assert.equal(await resolve('.note', 2), null);
});

test('returns nothing for a point outside any character', async () => {
  const hit = await page.evaluate(() => globalThis.zhDic.resolveAtPoint(880, 4));
  assert.equal(hit, null);
});

test('renders the popup with one tab per candidate, longest first', async () => {
  // Real candidates from the built shards, rendered by the real popup code.
  const { DEFAULT_SETTINGS } = await import('../extension/src/lib/settings.js');
  const candidates = await candidatesFor('中国菜很好吃', { sentence: '我喜欢吃中国菜。' });

  const rendered = await page.evaluate(
    async ([cands, settings]) => {
      const { x, y } = window.pointAtChar('#plain', 4);
      const popup = new globalThis.zhDic.Popup(settings);
      // The stylesheet is fetched over http; give it a moment before measuring.
      await new Promise((r) => setTimeout(r, 300));
      popup.show(cands, { left: x, top: y - 18, bottom: y + 18, right: x + 28 });
      await new Promise((r) => requestAnimationFrame(r));

      const host = document.querySelector('[data-zh-dic-host]');
      const box = host.getBoundingClientRect();
      return {
        visible: host.hasAttribute('data-visible'),
        onScreen: box.width > 100 && box.height > 40 && box.right <= innerWidth && box.bottom <= innerHeight,
      };
    },
    [candidates, DEFAULT_SETTINGS],
  );

  assert.deepEqual(
    candidates.map((c) => c.headword),
    ['中国菜', '中国', '中'],
  );
  assert.ok(rendered.visible, 'popup should be visible');
  assert.ok(rendered.onScreen, 'popup should be sized and fully within the viewport');

  await page.screenshot({ path: join(shotDir, 'popup.png') });
});
