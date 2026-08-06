# 瞄一下

A Chromium extension that shows pinyin and definitions for the Chinese word under your
pointer — when you hold <kbd>Shift</kbd>, or on hover alone if you'd rather not press
anything. Works fully offline; the dictionary is bundled, so nothing you read is sent
anywhere.

### Where the logs go

- **Content script** — the page's own DevTools console.
- **Service worker** — `brave://extensions` → the extension's **service worker** link.
  Errors during a lookup are logged there, not in the page.
- **The popup's internals** — expand `#shadow-root (open)` on the `[data-zh-dic-host]`
  element in the page's DOM tree. The root is deliberately `open`; see
  [popup.js](extension/src/content/popup.js) for why.

## Tests

```sh
npm test
```

Two suites, both running the code the extension actually ships:

- [test/lookup.test.mjs](test/lookup.test.mjs) — segmentation, tone marks, and card
  building, with `chrome` and `fetch` stubbed to read the built shards from disk.
- [test/dom.test.mjs](test/dom.test.mjs) — the parts that need real layout: resolving a
  pointer to a character, and reading a word forward across inline markup. Drives a local
  Chromium via puppeteer-core; set `ZH_DIC_BROWSER=<path>` if it can't find your browser.
- [test/audio.test.mjs](test/audio.test.mjs) — the Commons recording matcher, against
  recorded API responses so it needs no network and can't trip Wikimedia's rate limiting.
- [test/options.test.mjs](test/options.test.mjs) — the options page against stubbed storage
  and voice lists: which audio choices are offered, which is shown, and what is saved.
- [test/interaction.test.mjs](test/interaction.test.mjs) — the trigger behaviour, with real
  mouse and key events: both modes, dwell timing, the approach grace, and Escape. `content.js`
  reaches the outside world only through `chrome.runtime.sendMessage`, so the stub routes
  those back into Node where the real handler logic runs. The interaction model itself is not
  faked, and a configurable fake latency stands in for a cold service worker.

The DOM suite injects the content scripts into a page rather than loading the packaged
extension, because current Chrome/Brave stable refuse the `--load-extension` command-line
switch. `resolveAtPoint()` takes explicit viewport coordinates, so this tests the real
hit-testing against real layout — nothing meaningful is stubbed.

## Anki export

Not built yet, but the lookup path is shaped for it.
[card.js](extension/src/lib/card.js) already returns a superset of what a flashcard
needs — both scripts, tone-marked *and* numbered pinyin, the senses, the sentence the word
appeared in, and the source page — and the popup renders straight from that object. Adding
an exporter means adding a consumer of data that already reaches the popup, not changing
how lookups work.

The likely shape: a button in the popup that POSTs the active card to
[AnkiConnect](https://foosoft.net/projects/anki-connect/) on `localhost:8765`, which needs
`http://localhost:8765/` in `host_permissions` and Anki running with the add-on installed.
A file-based `.tsv` export needs no new permissions at all.

## Settings

Click the toolbar icon, or **Details → Extension options**. Changes apply to open tabs
immediately — no page reload.

**Trigger** is the main one. Either a held modifier — <kbd>Shift</kbd>, <kbd>Ctrl</kbd>,
<kbd>Alt</kbd> or <kbd>Win</kbd>/<kbd>Cmd</kbd> — or **No key, show on hover**, which looks
up any Chinese the pointer rests on. The two modes differ on purpose:

| | Held modifier | No key |
| --- | --- | --- |
| Opens | when you press the key | once the pointer rests for **Hover delay** |
| Closes | Esc, click, scroll, or pointer wanders 120px away | shortly after the pointer leaves Chinese text |
| Once open | stays up after you release, so tabs stay clickable | follows the pointer with no further delay |

**Hover delay** (hover mode only, default 300 ms) is what stops the popup flashing open on
every word the pointer crosses on its way somewhere else. Set it to 0 for instant lookups.
The row is hidden unless the keyless trigger is selected.

The delay gates *showing* the popup, not looking the word up — the two overlap, so the wait
is `max(delay, lookup)` rather than `delay + lookup`. Getting this wrong is why hover mode
used to feel slower than the modifier despite doing identical work; there's a regression test
for it in [test/interaction.test.mjs](test/interaction.test.mjs).

## Known limitations

- Only Han characters are read, so words mixing letters (`卡拉OK`, `AA制`) match just
  their Chinese part.
- No lookups inside `<input>`/`<textarea>` — `caretRangeFromPoint()` doesn't resolve
  positions in form-control text.
- The popup is positioned in viewport coordinates and closes on scroll rather than
  following the word.
- Segmentation is longest-match, not statistical, so it has no way to know that 中国人
  in a given sentence was meant as 中国 + 人. That's what the tabs are for.
- The computer voice reads the characters, so for a character with several readings it may
  not say the one you're looking at — TTS picks its own. A Commons recording matched via
  pinyin *is* reading-specific; the OS voice can't be forced without SSML support Chrome
  doesn't reliably provide.
- Wikimedia rate-limits bursts, which is why recordings are fetched only on click, never
  prefetched on hover, and both hits and misses are cached for the session.
