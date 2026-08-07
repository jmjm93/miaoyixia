# 瞄一下

An extension for Chromium-based browsers that opens a popup over the Chinese word you're hovering with its definition.
It contains sound and Anki support.

This app has been extensively vibecoded, if you're the type to care about that.

## Settings

Right-click the toolbar icon and choose **Options…**, or **Details → Extension options**.
Changes apply to open tabs immediately — no page reload, and the page mirrors changes made
from the toolbar while it's open.

### Lookups

**Enabled** switches the whole thing off without uninstalling it — the same toggle as clicking
the toolbar button.

**Language** sets the language of the extension's own text — this page, the popup's hint bar and
button tooltips, and the toolbar menu. **English** and **Español** are available, and the default
**Match browser** follows the browser's UI language. It's a setting rather than just following the
browser because a Spanish speaker on an English-language browser is a normal case, not an edge
one. See [Languages](#languages) for what this does *not* change.

**Definitions** sets the language of the definitions themselves, separately from **Language**
above. **English** ships in the extension. **Español** is not: it is ~10 MB, so it is downloaded
once, on request, from
[cedict-translations](https://github.com/jmjm93/cedict-translations) — then stored locally and
used offline like the English. The row below the control reports what's stored and can remove
it again.

The two are deliberately independent: a Spanish speaker may well prefer a Spanish interface
over CC-CEDICT's English definitions, which are the richer, human-edited original. Entries the
Spanish layer doesn't cover fall back to English one sense at a time, so a gap never means a
missing definition. See [Languages](#languages).

**Trigger** is the main one. Either a held modifier — <kbd>Shift</kbd>, <kbd>Ctrl</kbd>,
<kbd>Alt</kbd> or <kbd>Win</kbd>/<kbd>Cmd</kbd> — or **No key, show on hover**, which looks
up any Chinese the pointer rests on.

**Hover delay** (hover mode only, default 300 ms) is what stops the popup flashing open on
every word the pointer crosses on its way somewhere else. Set it to 0 for instant lookups.
The row is hidden unless the keyless trigger is selected.

**Show script** decides whether an entry leads with its simplified or traditional form. The
other one follows after a middot, and only when the two actually differ.

### Pronunciation

Every entry carries a speaker button — one **per reading**, so 打 *dá* and 打 *dǎ* are played
separately.

**Audio source**:

| | |
| --- | --- |
| *Voice, then recording* | Default. An installed Chinese voice, falling back to Wikimedia Commons. |
| *Computer voice only* | Offline and instant, and covers every entry. |
| *Wikimedia recordings only* | Real speakers, but only common words have one. |
| *No audio button* | Hides it entirely. |

Highly recommended to install Chinese voice on the computer as Wikimedia is not exhaustive and rate-capped.

**Playback speed** (0.5–1.2×) only ever *slows* playback. A human recording is already
correctly paced, so it's never sped up.

### Anki

**Show an “add to Anki” button** puts a `+` beside each speaker, again one per reading. Needs
Anki running with the [AnkiConnect](https://foosoft.net/projects/anki-connect/) add-on — but no
configuration on the Anki side.

**Local access** grants `127.0.0.1:8765`. It's an optional permission requested from this
button, so a default install never touches localhost.

**Connection** checks AnkiConnect and reports its version and how many decks it can see.

**Deck** and **Note type** specify which Deck or Notes should be used to add data. If they don't exist they'll be created.

**Tags** are space-separated and applied to every note added.

**Fields** generates one row per field of the chosen note type, read from your collection — so
any field naming works, and the shipped defaults are only a starting point. Each row binds to
one of:

> word (as hovered) · simplified · traditional · word tone-coloured · pinyin · pinyin
> tone-coloured · pinyin numbered · all definitions · definitions numbered · first definition ·
> example sentence · sentence with the word in bold · pronunciation audio · source link ·
> source URL · leave empty


### Appearance

**Theme** follows the system colour scheme by default, or can be pinned to light or dark.

**Font size** (11–22 px) scales the whole popup, not just its text — the tabs, the key badges
and the buttons are all sized relative to it.

**Senses shown before collapsing** (1–20) is how many definitions appear before the rest go
behind a “+n more” toggle. Some CC-CEDICT entries are very long, which is what this is for.

### Keyboard

Once a popup is open: <kbd>←</kbd>/<kbd>→</kbd> switch candidate words,
<kbd>1</kbd>–<kbd>9</kbd> jump to the tab showing that digit, and <kbd>Esc</kbd> closes it. In
hover mode <kbd>Esc</kbd> keeps it shut until the pointer reaches a different word, so it isn't
undone by the next mouse twitch.

## Languages

The interface and the definitions are set separately — **Language** and **Definitions** in the
options. Interface strings live in this repository; definitions come from the dictionary.

CC-CEDICT is Chinese–English, so English is what ships in the extension. Spanish definitions
come from [cedict-translations](https://github.com/jmjm93/cedict-translations), which machine-
translates CC-CEDICT's glosses with each entry's headword and pinyin as context (so 打 `[da2]`
is *docena* and 打 `[da3]` is *golpear*, rather than a coin toss). That layer is **not bundled**:
at ~10 MB it would double the download for everyone to serve the few who want it, and it
wouldn't scale past one extra language. It is fetched once, on request, and stored in
IndexedDB.

Consequences worth knowing:

- **Enabling Spanish needs a connection once.** Everything after that is local, including
  Anki's definition fields and the `+n more` senses.
- **The whole file is fetched at once, deliberately.** Shard indices derive from a word's head
  character, so fetching shards on demand would tell the host roughly which characters are being
  read. One upfront download leaks only that somebody enabled Spanish.
- **Coverage is 99.76%.** Entries the layer doesn't cover fall back to English one sense at a
  time, which also covers entries CC-CEDICT gains between gloss releases.
- **The version is pinned** ([`gloss-store.js`](extension/src/lib/gloss-store.js)). A stored
  layer built against an older CC-CEDICT is treated as absent rather than used, since entries
  shift between releases.

Adding another gloss language means publishing it in that repository and adding an entry to
`GLOSS_SOURCES`.

Strings live in one place, [`extension/src/lib/messages.js`](extension/src/lib/messages.js), as a
`{ language: { key: string } }` catalogue. Adding a language means adding a key to `LANGUAGES`, a
block of strings beside the others, and an `<option>` to the language control — `test/i18n.test.mjs`
then fails until every key is present and every placeholder accounted for.

Two details are worth knowing before editing it:

- It is a **classic script**, not a module, because the manifest loads it as a content script and
  `import`/`export` there is a syntax error. `i18n.js` next door re-exports it for the module side.
  A test enforces this.
- `chrome.i18n` is used only to read the browser's language. It isn't used for the strings
  themselves, because `getMessage()` always answers in the browser's UI language and can't be
  overridden. `_locales/` still holds the extension's name and description, which Chrome renders
  itself — those two are localised the standard way and appear per-locale in the Web Store.

Key names — <kbd>Shift</kbd>, <kbd>Ctrl</kbd>, <kbd>Alt</kbd> — are deliberately left untranslated
everywhere, since they're what's printed on the keyboard and they're also the exact
`KeyboardEvent.key` values the trigger is compared against.

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
