# 瞄一下

An extension for Chromium-based browsers that opens a popup over the Chinese word you're hovering with its definition.
It contains sound and Anki support.

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
