// Background service worker: owns the dictionary and the settings defaults.
//
// The content script deliberately holds no dictionary state -- it ships DOM text here
// and gets back render-ready cards. That keeps one copy of the data per browser rather
// than one per tab, and keeps the content script small enough to inject everywhere.

import { loadMeta, lookupCandidates, matchesByPosition } from '../lib/dict-store.js';
import { segment } from '../lib/segment.js';
import { ocrModel } from '../lib/ocr.js';
import { applyScript, buildCard } from '../lib/card.js';
import { clearGlosses, glossFor, glossInfo, glossReady, resetGlossReady } from '../lib/gloss-store.js';
import { exportAudioPlan, getSettings } from '../lib/settings.js';
import { fileUrl, searchForms, searchRecordings } from '../lib/audio-source.js';
import { synthesise } from '../lib/tts-source.js';
import { createClient, ensureTarget, noteOptions, reconcileMapping } from '../lib/anki.js';
import { buildFields } from '../lib/anki-fields.js';
import { MENU, actionTitle, iconPaths, menuState, rememberModifier, trigger } from '../lib/action-state.js';
import { t } from '../lib/i18n.js';

/**
 * Recordings fetched this session, keyed by word+reading. Misses are cached too: Commons
 * won't gain a recording mid-session, and Wikimedia rate-limits bursts, so asking twice for
 * a word it doesn't have is pure cost.
 */
const audioCache = new Map();
const MAX_CACHED_AUDIO = 24;

/**
 * Synthesised audio, kept apart from `audioCache` rather than sharing it. A caller that
 * insists on real recordings must never be handed a cached synthetic one, and keying by
 * service means switching provider in the options page doesn't serve the old voice.
 */
const ttsCache = new Map();

/**
 * Turn the forward-text the content script read at the cursor into tabs, one per
 * candidate length, longest first.
 */
/** Turn dictionary matches into render-ready tabs. Shared by hovering and by reading a snip. */
function buildCandidates(matches, context, lang, translating) {
  return Promise.all(
    matches.map(async ({ headword, length, entries }) => ({
      headword,
      length,
      cards: await Promise.all(
        entries.map(async (row) =>
          buildCard(headword, row, context, translating ? await glossFor(lang, headword, row) : null),
        ),
      ),
    })),
  );
}

/**
 * Whether definitions can be answered in the chosen language right now.
 *
 * English ships in the package, so it is never pending and never needs a lookup. Any other
 * language is downloaded, and until it is on disk the lookup quietly answers in English -- the
 * popup says so, but a missing download must never mean a missing definition.
 */
async function glossState(settings) {
  const lang = settings.glossLanguage;
  const translating = lang !== 'en' && (await glossReady(lang));
  return { lang, translating, glossPending: lang !== 'en' && !translating };
}

async function handleLookup({ text, sentence, url, title }) {
  const [settings, matches] = await Promise.all([getSettings(), lookupCandidates(text ?? '')]);
  const { lang, translating, glossPending } = await glossState(settings);

  // Every candidate for one hover starts with the same character, so all of these resolve
  // against a single memoised shard. The awaits are cheap after the first.
  const candidates = await buildCandidates(matches, { sentence, url, title }, lang, translating);
  return { candidates, glossPending };
}

/**
 * Read a whole recognised line: split it into words, and look each one up.
 *
 * Unlike a hover there is no cursor saying where a word begins, so the line has to be segmented
 * first -- see segment.js for why that is a shortest-path problem rather than greedy matching.
 *
 * Each token carries *every* match at its starting position, not just the one segmentation
 * chose. That is what makes a wrong split recoverable: the window shows those as the same
 * candidate tabs a hover offers, so picking a different length is one click rather than a
 * re-snip. It costs nothing extra either, since the matches were already computed to segment.
 *
 * The whole line travels as the sentence for every card, so a note made from one word still
 * records the context it was read in.
 */
async function handleRead({ text, url, title }) {
  const line = text ?? '';
  const chars = [...line];
  const [settings, matchesAt] = await Promise.all([getSettings(), matchesByPosition(line)]);
  const { lang, translating, glossPending } = await glossState(settings);

  const context = { sentence: line, url, title };
  const spans = segment(
    chars.length,
    matchesAt.map((matches) => matches.map((match) => match.length)),
  );

  const tokens = await Promise.all(
    spans.map(async ({ start, length }) => ({
      text: chars.slice(start, start + length).join(''),
      start,
      length,
      candidates: await buildCandidates(matchesAt[start] ?? [], context, lang, translating),
    })),
  );

  return { tokens, glossPending };
}

/**
 * A PNG of the visible tab, for the content script to crop the snipped region out of.
 *
 * captureVisibleTab isn't reachable from a content script, and it needs activeTab -- which the
 * toolbar click that started the snip is what granted. So this can only ever answer for a snip
 * the user actually asked for, and the screenshot never outlives the crop that follows it.
 */
async function handleCapture() {
  return { dataUrl: await chrome.tabs.captureVisibleTab({ format: 'png' }) };
}

/**
 * The recogniser lives in an offscreen document, not here.
 *
 * This worker is killed after roughly thirty seconds idle, and the OCR engine is ~6 MB of WASM
 * that takes a second or two to parse. Rebuilding it per snip would be most of the wait, so it
 * is held somewhere that outlives us. `creating` is kept because two snips in quick succession
 * would otherwise both find no document and both try to create one, and the second throws.
 */
let creating = null;

async function ensureRecogniser() {
  if (!(await chrome.offscreen.hasDocument())) {
    creating ??= chrome.offscreen
      .createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Runs the offline text recogniser used to read Chinese out of a screenshot.',
      })
      .finally(() => {
        creating = null;
      });
    await creating;
  }
  await waitForRecogniser();
}

/**
 * Wait until the offscreen document can actually take work.
 *
 * createDocument resolves once the document *exists*, which is well before its script has run --
 * offscreen.js is a module, so it is deferred. Sending straight after creating it loses that race
 * and fails as "Receiving end does not exist", which reads exactly like a missing document rather
 * than a slow one. Polling a ping costs a few milliseconds and removes the whole class of bug.
 *
 * hasDocument() being true is not enough on its own either: this worker restarts constantly, and
 * a fresh one has no idea how far along an existing document is.
 */
async function waitForRecogniser(attempts = 60, gap = 25) {
  for (let i = 0; i < attempts; i++) {
    try {
      const pong = await chrome.runtime.sendMessage({ type: 'ocr:ping' });
      if (pong?.ok) return;
    } catch {
      // Nothing listening yet, which is the case this loop exists for.
    }
    await new Promise((resolve) => setTimeout(resolve, gap));
  }
  // Distinguishable from the races above: at this point the document is genuinely not coming up,
  // which almost always means its script threw. chrome://extensions -> Inspect views has it.
  throw new Error('the recogniser did not start; check the offscreen document for errors');
}

/** Read Chinese out of a snipped image. The content script sends the crop, not the whole tab. */
async function handleRecognise({ dataUrl }) {
  // Read fresh every time rather than caching: the result window can change the script and
  // direction and ask to be read again, without a new snip.
  const settings = await getSettings();
  await ensureRecogniser();
  const response = await chrome.runtime.sendMessage({
    type: 'ocr:run',
    dataUrl,
    model: ocrModel(settings),
  });
  if (!response?.ok) throw new Error(response?.error ?? 'the recogniser did not answer');
  return response.result;
}

/**
 * The tab's page-zoom factor, so the result window can cancel it out.
 *
 * Only reachable from here: a content script has no way to read page zoom. devicePixelRatio does
 * move with it, but its resting value depends on the display, so the two cannot be separated from
 * inside the page.
 *
 * Answers 1 rather than throwing when it cannot be read. Zoom compensation is a nicety, and a
 * window at the wrong scale beats no window at all.
 */
async function handleZoom(_message, sender) {
  try {
    const factor = await chrome.tabs.getZoom(sender?.tab?.id);
    return { factor: factor > 0 ? factor : 1 };
  } catch (error) {
    console.debug('[zh-dic] could not read the tab zoom', error);
    return { factor: 1 };
  }
}

export const TRANSLATE_ORIGINS = ['https://translate.googleapis.com/*'];

/**
 * Machine-translate a snipped line.
 *
 * The only thing in this extension that sends anything a user read to a third party, so it is
 * off unless asked for, and the host permission is optional -- if it has not been granted this
 * cannot reach the network even if the setting somehow says otherwise.
 *
 * Answers `{ text: null }` rather than throwing when it is simply switched off, since the
 * content script calls this on every reading and "not enabled" is not an error.
 */
async function handleTranslate({ text }) {
  const settings = await getSettings();
  if (settings.translation !== 'google' || !text) return { text: null };

  if (!(await chrome.permissions.contains({ origins: TRANSLATE_ORIGINS }))) {
    throw new Error('translation is enabled but has no permission to reach the network');
  }

  // The public endpoint the Google Translate web page itself uses. No key, no account -- and no
  // support either, so a failure here is reported and dropped rather than retried.
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN' +
    `&tl=${encodeURIComponent(settings.glossLanguage || 'en')}&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`translation failed: ${response.status}`);

  // Deeply nested arrays: [0] holds the segments, each of which leads with its translation.
  const data = await response.json();
  const translated = (Array.isArray(data?.[0]) ? data[0] : [])
    .map((segment) => segment?.[0] ?? '')
    .join('')
    .trim();

  return { text: translated || null };
}

/** What the options page shows for the gloss layer: chosen, stored, and whether they agree. */
async function handleGlossStatus() {
  const { glossLanguage } = await getSettings();
  return {
    language: glossLanguage,
    ready: glossLanguage === 'en' || (await glossReady(glossLanguage)),
    info: glossLanguage === 'en' ? null : await glossInfo(glossLanguage),
  };
}

/**
 * Told by the options page that the stored layer changed.
 *
 * The download itself runs there, not here: it needs a user gesture for the permission prompt,
 * and an MV3 worker can be killed mid-transfer. Extension pages and this worker share an
 * origin, so what the options page writes to IndexedDB is what this worker reads -- it only
 * needs to be told to stop trusting its memo.
 */
function handleGlossChanged() {
  resetGlossReady();
  return {};
}

async function handleGlossClear({ language }) {
  await clearGlosses(language);
  return {};
}

/** Uint8Array -> base64, in chunks so a long file can't blow the argument limit. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Commons search failed: ${response.status}`);
  return response.json();
}

/**
 * Look for a human recording of `word` and return its bytes.
 *
 * The audio is fetched here rather than in the content script, and handed over as bytes
 * rather than a URL, so that playback needs no <audio> element in the page -- a page's CSP
 * `media-src` would otherwise block it. Only ever called from a click, never on hover.
 */
async function findRecording({ word, pinyin = '', simplified = '', traditional = '' }) {
  const forms = searchForms({ word, simplified, traditional });
  const key = `${forms.join('/')} ${pinyin}`;
  if (audioCache.has(key)) return audioCache.get(key);

  let result = { found: false };
  try {
    for (const form of forms) {
      const names = await searchRecordings(form, pinyin, getJson);
      if (!names.length) continue;
      const response = await fetch(fileUrl(names[0]));
      if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`);
      result = {
        found: true,
        name: names[0],
        mime: response.headers.get('content-type') ?? '',
        data: toBase64(await response.arrayBuffer()),
      };
      break;
    }
  } catch (error) {
    // Rate limiting or a network blip: report it, but don't cache a failure that may pass.
    return { found: false, error: String(error?.message ?? error) };
  }

  audioCache.set(key, result);
  while (audioCache.size > MAX_CACHED_AUDIO) audioCache.delete(audioCache.keys().next().value);
  return result;
}

/** Synthesise `word`, or return a miss. Never throws: a failed fallback must not lose a note. */
async function findSynthesised(word, { service, rate }) {
  if (!service || service === 'off' || !word) return { found: false };

  const key = `${service} ${word}`;
  if (ttsCache.has(key)) return ttsCache.get(key);

  let result;
  try {
    const audio = await synthesise(word, { service, rate });
    result = audio
      ? { found: true, name: `${word}${audio.extension}`, mime: audio.mime, data: toBase64(audio.data), tts: service }
      : { found: false };
  } catch (error) {
    // An undocumented endpoint that has changed or is throttling. Don't cache it -- the next
    // word may well work -- and let the caller carry on without audio.
    return { found: false, error: String(error?.message ?? error) };
  }

  ttsCache.set(key, result);
  while (ttsCache.size > MAX_CACHED_AUDIO) ttsCache.delete(ttsCache.keys().next().value);
  return result;
}

/**
 * Pronunciation for one word: a real recording where Commons has one, otherwise a synthesised
 * one. The two flags are what let each audio source mean only what it says -- 'recording' must
 * never return a synthetic voice, and 'voice' must not spend a Commons round trip. See
 * exportAudioPlan() for the mapping.
 */
async function handleAudio({
  word,
  pinyin = '',
  simplified = '',
  traditional = '',
  allowRecording = true,
  allowTts = true,
}) {
  const settings = await getSettings();
  const recording = allowRecording
    ? await findRecording({ word, pinyin, simplified, traditional })
    : { found: false };
  if (recording.found || !allowTts) return recording;

  const synthetic = await findSynthesised(word, {
    service: settings.ttsService,
    rate: settings.speechRate,
  });
  // A recording error is the more useful one to report if neither source produced anything.
  if (!synthetic.found && recording.error) return recording;
  return synthetic;
}

// --- Anki -------------------------------------------------------------------

const anki = createClient();

/** Fetch the audio for a card without re-downloading it if it's already cached. */
async function audioFor(card, settings) {
  const plan = exportAudioPlan(settings.audio);
  if (!plan.recording && !plan.tts) return null;

  const result = await handleAudio({
    word: card.headword,
    pinyin: card.pinyin,
    simplified: card.simplified,
    traditional: card.traditional,
    allowRecording: plan.recording,
    allowTts: plan.tts,
  });
  return result.found ? result : null;
}

/** What the options page needs to build its dropdowns: the live shape of the collection. */
async function handleAnkiCollection() {
  const [version, decks, models] = await Promise.all([anki.version(), anki.deckNames(), anki.modelNames()]);
  return { reachable: true, version, decks, models };
}

async function handleAnkiFields({ model }) {
  return { fields: await anki.modelFieldNames(model) };
}

/**
 * Can these words be added? Used to grey out the button for words already in the collection.
 *
 * Read-only on purpose: this runs whenever a popup opens, so it must never create a deck or a
 * note type. If the target doesn't exist yet the words are simply reported as addable, and
 * creation happens on the click.
 */
async function handleAnkiInspect({ cards }) {
  const settings = await getSettings();
  const [decks, models] = await Promise.all([anki.deckNames(), anki.modelNames()]);

  if (!decks.includes(settings.ankiDeck) || !models.includes(settings.ankiModel)) {
    return { ready: false, states: cards.map(() => ({ canAdd: true, duplicate: false, error: '' })) };
  }

  const fields = await anki.modelFieldNames(settings.ankiModel);
  const mapping = reconcileMapping(settings.ankiFields, fields);
  // Normalised the same way the add path will, or duplicate detection would compare a form
  // that is never written -- reporting 個 as addable when the deck already holds 个.
  const notes = cards.map((card) => ({
    deckName: settings.ankiDeck,
    modelName: settings.ankiModel,
    fields: buildFields(mapping, applyScript(card, settings.ankiScript)),
    options: noteOptions(settings.ankiDeck),
  }));

  return { ready: true, states: await anki.inspect(notes) };
}

/** Add one note, creating the deck and note type first if they're missing. */
async function handleAnkiAdd({ card }) {
  const settings = await getSettings();
  const created = await ensureTarget(anki, {
    deck: settings.ankiDeck,
    model: settings.ankiModel,
    fields: settings.ankiFields,
  });

  const fields = await anki.modelFieldNames(settings.ankiModel);
  const mapping = reconcileMapping(settings.ankiFields, fields);
  const written = applyScript(card, settings.ankiScript);

  // Only bother fetching audio when a field actually wants it.
  let audioFilename = '';
  let audioSource = '';
  if (Object.values(mapping).includes('audio')) {
    const audio = await audioFor(written, settings);
    if (audio) {
      const extension = audio.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.mp3';
      // Named so notes from this extension are distinguishable from other sources', and so the
      // provider is visible in the media folder: a voice someone dislikes can then be found and
      // replaced without guessing which files came from where.
      const provider = audio.tts ? audio.tts : 'commons';
      audioFilename = await anki.storeMedia(
        `${written.headword}_miaoyixia_${provider}_zh-CN${extension}`,
        audio.data,
      );
      audioSource = audio.tts ? 'tts' : 'recording';
    }
  }

  const noteId = await anki.addNote({
    deckName: settings.ankiDeck,
    modelName: settings.ankiModel,
    fields: buildFields(mapping, written, { audioFilename }),
    tags: settings.ankiTags.split(/\s+/).filter(Boolean),
    options: noteOptions(settings.ankiDeck),
  });

  return { noteId, created, audio: Boolean(audioFilename), audioSource, deck: settings.ankiDeck };
}

const HANDLERS = {
  lookup: handleLookup,
  read: handleRead,
  capture: handleCapture,
  recognise: handleRecognise,
  translate: handleTranslate,
  zoom: handleZoom,
  audio: handleAudio,
  ankiCollection: handleAnkiCollection,
  ankiFields: handleAnkiFields,
  ankiInspect: handleAnkiInspect,
  ankiAdd: handleAnkiAdd,
  glossStatus: handleGlossStatus,
  glossChanged: handleGlossChanged,
  glossClear: handleGlossClear,
  getSettings,
  getMeta: loadMeta,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;

  // Promise.resolve rather than handler(...).then: a handler that does no I/O is allowed to be
  // an ordinary function, and one that throws synchronously must still answer. Without this,
  // either case kills the message port and surfaces at the caller as a bare
  // "handler(...).then is not a function" with no clue which message caused it.
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (error) => {
        console.error(`[zh-dic] ${message.type} failed`, error);
        sendResponse({ ok: false, error: String(error?.message ?? error) });
      },
    );
  return true; // response is async
});

// --- toolbar button ----------------------------------------------------------
//
// Left click starts a snip; the right-click menu holds enabling, the trigger key and options. A
// button can have a popup or an onClicked handler but not both, and the snip is the only thing
// here that has to be *started* -- everything else is a setting, which a menu states better than
// a button whose meaning changes with its own state.
//
// The obvious alternative, click to snip and hold to toggle, isn't available: chrome.action
// reports a click and nothing else, with no press duration and no separate down/up, so an
// extension cannot tell a long press from a short one.

/**
 * Push current settings onto the icon, tooltip, badge and menu checkboxes.
 *
 * Each call is reported and failures are logged rather than left as an unhandled rejection: a
 * refusal here shows up as "the icon just doesn't change", which is near-impossible to diagnose
 * from the outside. Look for these lines in the service worker's console.
 */
async function refreshAction() {
  const settings = await getSettings().catch(() => null);
  if (!settings) return;

  const isMac = navigator.userAgent.includes('Mac');
  const paths = iconPaths(settings.enabled);

  // Applied independently and reported by name. Previously these were awaited in one try block
  // with the icon first, so one failing call silently took the others with it.
  const steps = [
    ['icon', () => chrome.action.setIcon({ path: paths })],
    ['title', () => chrome.action.setTitle({ title: actionTitle(settings, isMac) })],
    // The state is carried entirely by the artwork -- a grey, sleeping cat. A badge sat on top
    // of it and hid the drawing. Kept as an explicit clear so any badge left by an earlier
    // version of the extension goes away rather than sticking permanently.
    ['badge', () => chrome.action.setBadgeText({ text: '' })],
  ];

  for (const [what, run] of steps) {
    try {
      await run();
    } catch (error) {
      console.error(`[瞄一下] could not set the toolbar ${what}`, error);
    }
  }

  // The menu may not exist yet on first run; updating a missing id is not worth throwing over.
  for (const [id, state] of Object.entries(menuState(settings, isMac))) {
    await chrome.contextMenus.update(id, state).catch(() => {});
  }
}

/**
 * (Re)create the action's context menu.
 *
 * Also called when the language changes: contextMenus.update can retitle the two checkboxes,
 * but the separator and the Options item are created once with a fixed title, so translating
 * them means building the menu again. The titles set here are immediately overwritten by
 * refreshAction() for the two items whose text depends on settings.
 */
function buildMenu() {
  // removeAll first: creating an existing id throws, and the worker restarts often.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.enabled, title: t('enabled'), type: 'checkbox', contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU.modifier, title: t('menuRequireAKey'), type: 'checkbox', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'sep', type: 'separator', contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU.options, title: t('menuOptions'), contexts: ['action'] });
    refreshAction();
  });
}

// getSettings() pins the language, so read it before drawing anything with text in it.
chrome.runtime.onInstalled.addListener(() => getSettings().then(buildMenu, buildMenu));
chrome.runtime.onStartup.addListener(refreshAction);

chrome.action.onClicked.addListener(async (tab) => {
  const { enabled } = await getSettings();

  // While off, a snip would lead nowhere, so the click turns the extension back on instead --
  // the button is never a dead end, and the tooltip says as much. Disabling lives in the menu.
  if (!enabled) {
    await chrome.storage.sync.set({ enabled: true });
    return;
  }
  if (!tab?.id) return;

  // Two very different things land here. Some pages genuinely have no content script and never
  // will -- the Web Store, chrome:// URLs, the PDF viewer -- and nothing can be done about those.
  // But a tab that was already open when the extension was reloaded or updated has no live
  // content script either, because Chrome does not inject into existing tabs, and *that* one is
  // fixed by reloading the page. Warn rather than debug: console.debug is filtered out at
  // DevTools' default log level, so the only symptom was a button that did nothing.
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'snip' });
  } catch (error) {
    console.warn(
      '[zh-dic] could not start a snip in this tab. If the page was open before the extension ' +
        'was last reloaded or updated, reload the page. Otherwise it is a page extensions cannot ' +
        'run on.',
      error,
    );
  }
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === MENU.options) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId === MENU.enabled) {
    await chrome.storage.sync.set({ enabled: Boolean(info.checked) });
    return;
  }
  if (info.menuItemId === MENU.modifier) {
    const settings = await getSettings();
    await chrome.storage.sync.set(trigger(settings, Boolean(info.checked)));
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;

  // Remember the chosen modifier wherever it was changed from, so the menu can restore it.
  if (changes.triggerKey) {
    const patch = rememberModifier(await getSettings());
    if (patch) await chrome.storage.sync.set(patch);
  }

  // The menu items with fixed titles can only be relabelled by recreating them. buildMenu ends
  // in refreshAction, so this isn't skipping the usual update.
  if (changes.uiLanguage) {
    await getSettings();
    buildMenu();
    return;
  }
  await refreshAction();
});

// The worker may have started for a lookup rather than an event; make sure the icon is right.
refreshAction();
