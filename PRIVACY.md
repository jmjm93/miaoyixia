# Privacy Policy — 瞄一下 (miaoyixia)

**Last updated: 10 October 2026**

**Short version: this extension collects nothing.** There is no analytics, no telemetry, no
advertising, and no account. The page you are reading is never sent anywhere, and no record of
what you look up is kept. Two things can leave your device, both described in full below and both
switchable off: a single word, when you ask to hear it or save it to a flashcard, to fetch its
pronunciation; and — only if you turn it on, which it is not by default — a sentence you have
captured from an image, to translate it. Reading text out of an image happens entirely on your
machine, and no picture of your screen is ever transmitted.

## What happens on your device

When you hover a Chinese word, the extension reads a short run of text around the pointer to
work out which word you mean, and looks it up in a dictionary **bundled inside the extension
itself** — a copy of [CC-CEDICT](https://cc-cedict.org/) with 124,766 entries. This lookup is
entirely local. The page you are reading is never transmitted, stored, or logged.

## Reading text from images

Clicking the toolbar button lets you drag a box over part of the page. To do that, the extension
takes a screenshot of the tab you are looking at, crops it to the box you drew, and reads the
Chinese in it. **All of this happens on your machine.** The recogniser and its language models
are bundled inside the extension — about 13 MB of them — and run in a hidden page belonging to
the extension, not on any server.

**No image ever leaves your device.** The screenshot exists only in memory, is cropped
immediately to the region you selected, and is discarded when the result window closes. It is
never saved to disk, uploaded, or logged. The text that comes out of it is then looked up in the
same bundled dictionary a hover uses.

The screenshot is taken at the moment you click the toolbar button, which is what `activeTab`
permits. That permission is granted by the click itself and lapses afterwards; it does not let
the extension look at your tabs at any other time, and no screenshot is ever taken without you
starting one.

## What is stored

Only your own settings: which key triggers a lookup, the hover delay, simplified or traditional
preference, audio source, which synthesised-voice service to fall back on, playback speed, theme,
font size, and your Anki deck, note type, field mapping and which script cards are written in.

These are saved with Chrome's `storage.sync`, which means Chrome syncs them between your own
signed-in Chrome installations. That synchronisation is handled by Google as part of your Chrome
profile; the developer of this extension has no access to it.

No browsing history, page content, or record of the words you look up is stored — not locally,
not remotely.

If you explicitly enable the optional Japanese preview, its downloaded dictionary and two OCR
models are stored in local IndexedDB. They are not synced to other devices. Disabling Japanese
keeps these files for reuse; **Remove** deletes them. Your enable/disable and reading-language
preferences are settings saved with `storage.sync`, like the other preferences above.

## What leaves your device

Six things, and none of them happen unless you ask for them:

**1. Pronunciation recordings.** If you click the speaker button on an entry, or add a card with
an audio field, the extension asks
[Wikimedia Commons](https://commons.wikimedia.org/) whether it has a recording of that word, and
downloads it if so. The only thing sent is the word itself — and, when its simplified and
traditional forms differ, that other form too, because recordings there are usually filed under
the simplified spelling. No identifier, no page address, no reading, nothing about you. Wikimedia
will see the request in the ordinary way any website sees a visit — their
[privacy policy](https://foundation.wikimedia.org/wiki/Policy:Privacy_policy) applies to it.

If you have a Chinese voice installed on your computer, the speaker button uses that instead and
**no network request is made at all** — unless you have set *Audio source* to "Wikimedia
recordings only", which asks Commons even when a local voice is available. Setting it to "No audio
button" disables both this and the synthesised voice below entirely.

**2. Synthesised pronunciation.** Commons only has recordings for a minority of words, so when
one is missing the extension can ask a text-to-speech service for the word instead. This is what
*Synthesised fallback* selects, and it is set to **Google Translate** by default; **Baidu
Translate** is the alternative, and **None** turns it off completely.

What is sent is the single word, plus the fact that Mandarin audio is wanted for it. Nothing else
— no identifier, no page address, no reading, nothing about you. Both are requests to a public
consumer endpoint of the kind a browser makes when you use those sites, and the operator's own
privacy policy applies:
[Google](https://policies.google.com/privacy) and
[Baidu](https://privacy.baidu.com/). Note that Baidu is a Chinese company, subject to Chinese law,
which you may weigh differently from the other services listed here.

This happens when you click the speaker and no recording or local voice can serve it, and when
you add a card whose audio field would otherwise be left empty — an exported card cannot use the
voice installed on your computer, because there is no way to capture it to a file. Setting
*Audio source* to "Wikimedia recordings only", or *Synthesised fallback* to "None", stops any
request to these services being made at all.

**3. The Spanish definitions.** If you set *Definitions* to Español and click **Download**, the
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

**4. Anki flashcards.** If you turn on Anki export and click the **+** on an entry, the word,
pinyin, definitions, the sentence you found it in and the page address are sent to
`http://127.0.0.1:8765` — the [AnkiConnect](https://foosoft.net/projects/anki-connect/) add-on
running in your own copy of Anki, on your own machine. This traffic never leaves your computer.
Access to that address is an *optional* permission, requested only if you switch the feature on;
if you never do, it is never granted and never used.

**5. A sentence you captured, for translation — off by default.** If you switch *Translate the
sentence* on, the text read out of an image is sent to
[Google Translate](https://translate.googleapis.com/) to be translated into your definitions
language. Only that line is sent: not the picture, not the page, not its address, and nothing
identifying you. [Google's privacy policy](https://policies.google.com/privacy) applies to the
request.

This is the only feature that sends anything you have *read* to a third party, so it is off
unless you choose otherwise, and the permission to reach that address is *optional* — until you
turn the setting on it is never requested, and the browser itself blocks the request rather than
this extension merely promising not to make it. Turning the setting back off stops it at once.
Hovering, dictionary lookups and reading text from images are all unaffected either way: none of
them ever touch the network.

**6. Optional Japanese download.** Enabling/downloading Japanese in Options fetches a pinned English
JMdict dictionary from a public GitHub release and two Japanese Tesseract language models from
`raw.githubusercontent.com`, about 17 MB in total. GitHub's release download redirects to
`release-assets.githubusercontent.com`. Access is an optional permission requested only when you
ask to download. No Japanese dictionary or model downloads happen on installation, startup,
hovering or capturing an image. Only public file requests are made: no word, sentence, image or
page address is sent. Once downloaded, Japanese lookup and OCR work locally without a network
connection. The Japanese preview has no pronunciation fetching, Anki export or sentence
translation. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
applies to the download requests.

## What is never collected

- Analytics, usage statistics, crash reports or telemetry of any kind
- The contents of pages you visit
- Your browsing history, bookmarks, tabs or cookies
- Names, email addresses, passwords, or any account information
- Any identifier that could be used to recognise you across sessions or sites

Nothing is sold or rented, and nothing is shared for advertising, profiling or any commercial
purpose. There is no server operated by this extension, and no account, so there is nowhere for a
record of your reading to accumulate.

The extension does send individual words to the third parties named above — Wikimedia, Google or
Baidu — but only to fetch audio for a word you asked to hear or to save, one word at a time, with
nothing attached that identifies you or the page. Those services see a bare request for a word,
as they would from anyone visiting them. If you would rather no word ever left your machine, set
*Audio source* to "No audio button", or install a Chinese voice and set *Synthesised fallback* to
"None" — the dictionary itself is bundled in the extension and never needs the network.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save the settings above |
| `unlimitedStorage` | Keep optional downloaded definition and Japanese data packs locally |
| `contextMenus` | The right-click menu on the extension's own toolbar button |
| `activeTab` | Take a screenshot of the tab you are looking at, at the moment you click the toolbar button, so that text in an image can be read. It grants nothing at any other time, and the screenshot never leaves your device. |
| `offscreen` | Run the bundled text recogniser in a hidden page of the extension's own. The background worker Chrome gives extensions is shut down too often to hold a recogniser this size. |
| Access to all sites | Chinese text can appear anywhere, so the dictionary must be able to read the word under your pointer wherever you are reading. Used locally only. |
| `commons.wikimedia.org`, `upload.wikimedia.org` | Download a human pronunciation recording of a word you asked to hear or to save |
| `translate.google.com`, `fanyi.baidu.com` | Fetch a synthesised pronunciation of that word when no recording exists. Only the one you select as *Synthesised fallback* is ever contacted, and neither is if you set it to "None". |
| `127.0.0.1:8765` (optional) | Send a flashcard to your own local Anki |
| `raw.githubusercontent.com` (optional) | Download the Spanish definitions or Japanese OCR models, only if you ask for them |
| `github.com`, `release-assets.githubusercontent.com` (optional) | Download the Japanese dictionary when you explicitly enable/download Japanese |
| `translate.googleapis.com` (optional) | Translate a sentence captured from an image, only if you turn *Translate the sentence* on |

The extension requests no access to your browsing history, bookmarks, cookies or downloads, and
cannot read tabs you are not looking at. Its only access to a tab is `activeTab`, which Chrome
grants for the current tab at the moment you click the toolbar button and which is what allows
the screenshot described above.

## Children

The extension is a dictionary and is suitable for all ages. As it collects no data at all, it
collects none from children either.

## Changes

Any change to this policy will be published at this address, with the date above updated. The
full source code of the extension is available in this repository, so any change in what it does
is visible in its history.

## Contact

Questions or concerns: open an issue at
<https://github.com/jmjm93/miaoyixia/issues>, or email me at dd091193@gmail.com .
