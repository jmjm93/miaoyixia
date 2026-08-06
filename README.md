# zh-dic

A Chromium extension that shows pinyin and definitions for the Chinese word under your
pointer — when you hold <kbd>Shift</kbd>, or on hover alone if you'd rather not press
anything. Works fully offline; the dictionary is bundled, so nothing you read is sent
anywhere.

When several dictionary words start at the character you're hovering, each one becomes a
tab, ordered longest first:

```
┌─────────────────────────────────────────┐
│ [中国菜 1]  中国 2   中 3                │   ← longest first; the badge is the
├─────────────────────────────────────────┤      digit that selects that tab
│ 中国菜 · 中國菜   Zhōng guó cài      🔊 │   ← one per reading
│   1. Chinese cuisine                    │
└─────────────────────────────────────────┘
```

## There is nothing to compile

The extension is plain ES modules, HTML and CSS — Chromium runs the source directly.
The only build step generates the bundled dictionary, because the raw CC-CEDICT file
isn't checked in:

```sh
npm run build
```

That does three things: downloads CC-CEDICT to `vendor/`, compiles it into
`extension/data/shards/`, and draws the PNG icons. Run it once before loading the
extension. Re-run `npm run fetch-dict && npm run build-dict` whenever you want a fresher
dictionary.

## Loading it in Brave

Brave is Chromium, so it uses the same unpacked-extension flow as Chrome:

1. Go to `brave://extensions` (Chrome: `chrome://extensions`).
2. Turn on **Developer mode** — top-right toggle.
3. Click **Load unpacked** and select the **`extension/`** folder (the one containing
   `manifest.json`), not the repo root.
4. Open any page with Chinese text and hold <kbd>Shift</kbd> over a character.

`test/page.html` is a fixture covering the awkward cases — words split by inline markup,
ruby annotations, traditional characters, dark backgrounds, the viewport edge. To use it,
either serve it (`npx serve .`) or tick **Allow access to file URLs** on the extension's
details page, since Chromium blocks content scripts on `file://` by default.

### The edit/reload loop

| You changed | What to do |
| --- | --- |
| A content script or `popup.css` | Reload the extension, then reload the page |
| `src/background/` or `src/lib/` | Reload the extension (the worker restarts on its own) |
| `manifest.json` | Reload the extension |
| The dictionary data | Reload the extension — shards are cached in worker memory |

"Reload the extension" is the ↻ icon on its card in `brave://extensions`.

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

## How it works

```
content script                        service worker
──────────────                        ──────────────
text-at-point.js  pointer → character
                  read word forward
        │
        │  { text: "中国菜很好吃", sentence, url }
        ├────────────────────────────────────────▶  dict-store.js
        │                                            longest-match, all lengths
        │                                          card.js
        │  { candidates: [中国菜, 中国, 中] }          tone marks, senses
        ◀────────────────────────────────────────┤
popup.js          render one tab per candidate
```

**The dictionary is sharded by first character.** Every candidate for a hover starts at
the same character, so a lookup only ever touches one of 128 shards. That matters because
an MV3 service worker is killed after ~30s idle: a cold lookup parses ~130 KB rather than
the whole 16 MB dictionary. Shards are memoised with a small LRU, and the mapping lives in
two places that must agree — `shardFor()` in
[tools/build-dict.mjs](tools/build-dict.mjs) and
[dict-store.js](extension/src/lib/dict-store.js).

**No dictionary state in the content script.** It sends DOM text and gets back
render-ready cards, so there's one copy of the data per browser rather than one per tab.

**Two things make hit-testing awkward** and are handled in
[text-at-point.js](extension/src/content/text-at-point.js): `caretRangeFromPoint()`
returns an insertion point rather than a character, so both neighbouring glyphs are
measured to find which one the pointer is actually over; and Chinese words routinely
straddle inline markup (`中<a>国</a>菜`), so the inline run of the containing block is
walked rather than just the hovered text node.

That walk goes *outward from the cursor* and takes only as much as it needs from each text
node, in both directions. Reading each node whole and checking afterwards made the cost scale
with block size — 1.3 ms on a 20,000-character `<p>`, paid every frame in hover mode. Bounded,
it's flat and unmeasurable. `caretRangeFromPoint()` itself costs nothing at any size.

**Permissions:** `storage` for settings, plus `commons.wikimedia.org` and
`upload.wikimedia.org` for pronunciation recordings. **Dictionary lookups never touch the
network** — that path is entirely local. Wikimedia is contacted only when you click a play
button and no Chinese voice is installed; set **Audio source** to *Computer voice only* or
*No audio button* and the extension makes no network requests at all.

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

### Pronunciation

Each entry carries a speaker button at its top-right — one **per reading**, so 打 *dá* and 打
*dǎ* get their own. Two sources, chosen by **Audio source**:

| | Computer voice | Wikimedia recording |
| --- | --- | --- |
| What | your OS's Chinese TTS voice | a real speaker, from [Commons](https://commons.wikimedia.org/) |
| Coverage | all 124,766 entries | common words only — 18 of 19 in a sample of frequent words, thinner further out |
| Cost | instant, offline | one network round trip, then cached |
| Needs | a zh voice installed (see below) | nothing |

`auto` uses the voice when one exists and falls back to a recording otherwise. *Computer voice
only* and *Wikimedia recordings only* do exactly what they say — neither falls back to the
other.

**The installed voice is the better source**, and the options page says so: it's instant,
entirely offline, and covers every entry, where Commons only has common words. So when no
Chinese voice is detected, the two voice-dependent choices are greyed out and recordings are
used instead. What gets *saved* differs between them, which matters:

- *Computer voice only* cannot work at all without a voice, so it's corrected in storage.
- *Voice, then recording* already falls back correctly, so it is only **displayed** as the
  recording option and left stored untouched — install a voice later and your choice comes
  back by itself, instead of leaving you stranded on recordings-only.

[test/options.test.mjs](test/options.test.mjs) pins that whole matrix.

**There is no free public audio API from any Chinese dictionary.** CC-CEDICT has no audio,
Forvo needs a paid key, and the Youdao/Google TTS endpoints other extensions use are
undocumented and against their terms. Commons is the only properly-licensed free option, and
the OS voice is the only one with full coverage — hence both.

**Installing a Chinese voice** is worth it: audio then works offline, instantly, for every
entry, with no network request. The options page detects whether you have one and gives the
exact steps (Windows: Settings → Time & language → Language & region → Add *Chinese
(Simplified, China)* → tick **Speech**, then restart the browser).

Two implementation notes, both non-obvious:

- **Matching a recording has to be exact.** Commons only offers a title search, and
  `intitle:` matches substrings — so 中国 also returns 中国功夫 ("Chinese kung fu"), 他 returns
  奥司他韦 ("oseltamivir"), and 打 returns 打嘴巴. Playing the wrong word is worse than playing
  nothing, so the word encoded in the filename must match exactly, and Cantonese/Japanese/Min
  Nan recordings of the same characters are filtered out by language tag.
  [test/audio.test.mjs](test/audio.test.mjs) pins each of those real cases. Filenames written
  in pinyin are matched against the entry's reading, which both widens coverage and keeps the
  result reading-specific.
- **Playback avoids `<audio>`.** The bytes are fetched in the service worker and played
  through Web Audio in the content script. A media element loads a resource, so a page's CSP
  `media-src` can block it, and plenty of sites restrict that; Web Audio is handed raw bytes,
  so there is nothing for a page policy to refuse.

Recordings are only ever slowed by **Playback speed**, never sped up — a human recording is
already correctly paced.

### Reaching the popup in hover mode

The popup sits about 12px below the word, and a pointer crosses that gap *between* two
mousemove samples — so the sample that lands in the gap finds no Chinese. Closing on that
sample makes the popup almost impossible to click. Instead the close is deferred, and how
long depends on where the pointer is heading:

- **Heading for the popup** — 800 ms of grace, refreshed on each sample that's still aimed
  at it, so a slow deliberate reach never gets cut off.
- **Heading anywhere else** — 150 ms.
- **Over the popup** — cancelled outright.

"Heading for it" is the angle between pointer movement and the *nearest point on the popup's
box*, so it works whether the popup is below the word, flipped above it, or clamped sideways
at a viewport edge. Moving away never shortens a grace already granted, so one stray sample
mid-reach can't kill it.

The rest: which script to show first, theme, font size, and how many senses to show before
collapsing.

Once the popup is up: <kbd>←</kbd>/<kbd>→</kbd> switch candidates, <kbd>1</kbd>–<kbd>9</kbd>
jump to the tab showing that digit, <kbd>Esc</kbd> closes. Holding a modifier and moving
sweeps along a line. In hover mode <kbd>Esc</kbd> keeps the popup shut until the pointer
reaches a different word, so it isn't undone by the next mouse twitch.

<kbd>Win</kbd> is offered for completeness but is a poor choice on Windows — it opens the
Start menu. <kbd>Cmd</kbd> is fine on macOS.

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

## Licence and attribution

Definitions come from [CC-CEDICT](https://cc-cedict.org/), used under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The generated files under
`extension/data/` are a derivative of it and carry the same licence, so anything you
distribute that includes them must keep the attribution and share-alike terms. The
attribution is shown on the options page.
