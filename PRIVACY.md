# Privacy Policy — 瞄一下 (miaoyixia)

**Last updated: 6 August 2026**

**Short version: this extension collects nothing.** There is no analytics, no telemetry, no
advertising, and no account. Nothing you read is sent anywhere.

## What happens on your device

When you hover a Chinese word, the extension reads a short run of text around the pointer to
work out which word you mean, and looks it up in a dictionary **bundled inside the extension
itself** — a copy of [CC-CEDICT](https://cc-cedict.org/) with 124,766 entries. This lookup is
entirely local. The page you are reading is never transmitted, stored, or logged.

## What is stored

Only your own settings: which key triggers a lookup, the hover delay, simplified or traditional
preference, audio source and playback speed, theme, font size, and your Anki deck, note type and
field mapping.

These are saved with Chrome's `storage.sync`, which means Chrome syncs them between your own
signed-in Chrome installations. That synchronisation is handled by Google as part of your Chrome
profile; the developer of this extension has no access to it.

No browsing history, page content, or record of the words you look up is stored — not locally,
not remotely.

## What leaves your device

Three things, and all of them only when you explicitly click something:

**1. Pronunciation recordings.** If you click the speaker button on an entry and no Chinese
voice is installed on your computer, the extension asks
[Wikimedia Commons](https://commons.wikimedia.org/) whether it has a recording of that word, and
downloads it if so. The only thing sent is the single word and its pinyin reading. No identifier,
no page address, nothing about you. Wikimedia will see the request in the ordinary way any
website sees a visit — their
[privacy policy](https://foundation.wikimedia.org/wiki/Policy:Privacy_policy) applies to it.

If you have a Chinese voice installed, your computer speaks the word and **no network request is
made at all**. Setting *Audio source* to "Computer voice only" or "No audio button" disables the
Wikimedia request entirely.

**2. The Spanish definitions.** If you set *Definitions* to Español and click **Download**, the
extension fetches one file from
[github.com](https://github.com/jmjm93/cedict-translations) — the Spanish dictionary itself,
about 10 MB. It is a plain download of a public file. **Nothing about you, and nothing you have
looked up, is sent**; the request says only that somebody is downloading that file, exactly as
if you had clicked the link in a browser. GitHub sees it the ordinary way any website sees a
visit.

The whole dictionary is downloaded in one go, on purpose. Fetching pieces of it as you read
would let the server infer which words you were looking at; one upfront download cannot. Once
it is stored, **no further requests are ever made** — Spanish lookups are as offline as English
ones. Access to that address is an *optional* permission, requested at the moment you click
Download; if you never do, it is never granted. Removing the download deletes it from your
machine.

**3. Anki flashcards.** If you turn on Anki export and click the **+** on an entry, the word,
pinyin, definitions, the sentence you found it in and the page address are sent to
`http://127.0.0.1:8765` — the [AnkiConnect](https://foosoft.net/projects/anki-connect/) add-on
running in your own copy of Anki, on your own machine. This traffic never leaves your computer.
Access to that address is an *optional* permission, requested only if you switch the feature on;
if you never do, it is never granted and never used.

## What is never collected

- Analytics, usage statistics, crash reports or telemetry of any kind
- The contents of pages you visit
- Your browsing history, bookmarks, tabs or cookies
- Names, email addresses, passwords, or any account information
- Any identifier that could be used to recognise you across sessions or sites

No data is sold, rented, or shared with third parties. There is no server operated by this
extension to send anything to.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save the settings above |
| `contextMenus` | The right-click menu on the extension's own toolbar button |
| Access to all sites | Chinese text can appear anywhere, so the dictionary must be able to read the word under your pointer wherever you are reading. Used locally only. |
| `commons.wikimedia.org`, `upload.wikimedia.org` | Download a pronunciation recording when you click the speaker |
| `127.0.0.1:8765` (optional) | Send a flashcard to your own local Anki |

The extension requests no access to your tabs, browsing history, cookies, or downloads.

## Children

The extension is a dictionary and is suitable for all ages. As it collects no data at all, it
collects none from children either.

## Changes

Any change to this policy will be published at this address, with the date above updated. The
full source code of the extension is available in this repository, so any change in what it does
is visible in its history.

## Contact

Questions or concerns: open an issue at
<https://github.com/jmjm93/miaoyixia/issues>, or email `<ADD YOUR CONTACT EMAIL HERE>`.
