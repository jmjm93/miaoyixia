// Background service worker: owns the dictionary and the settings defaults.
//
// The content script deliberately holds no dictionary state -- it ships DOM text here
// and gets back render-ready cards. That keeps one copy of the data per browser rather
// than one per tab, and keeps the content script small enough to inject everywhere.

import { loadMeta, lookupCandidates } from '../lib/dict-store.js';
import { buildCard } from '../lib/card.js';
import { clearGlosses, glossFor, glossInfo, glossReady, resetGlossReady } from '../lib/gloss-store.js';
import { getSettings } from '../lib/settings.js';
import { fileUrl, searchRecordings } from '../lib/audio-source.js';
import { createClient, ensureTarget, reconcileMapping } from '../lib/anki.js';
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
 * Turn the forward-text the content script read at the cursor into tabs, one per
 * candidate length, longest first.
 */
async function handleLookup({ text, sentence, url, title }) {
  const [settings, matches] = await Promise.all([getSettings(), lookupCandidates(text ?? '')]);
  const context = { sentence, url, title };

  // English ships in the package, so it is never pending and never needs a lookup. Any other
  // language is downloaded, and until it is on disk the lookup quietly answers in English --
  // the popup says so, but a missing download must never mean a missing definition.
  const lang = settings.glossLanguage;
  const translating = lang !== 'en' && (await glossReady(lang));

  // Every candidate for one hover starts with the same character, so all of these resolve
  // against a single memoised shard. The awaits are cheap after the first.
  const candidates = await Promise.all(
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

  return { candidates, glossPending: lang !== 'en' && !translating };
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
async function handleAudio({ word, pinyin = '' }) {
  const key = `${word} ${pinyin}`;
  if (audioCache.has(key)) return audioCache.get(key);

  let result;
  try {
    const names = await searchRecordings(word, pinyin, getJson);
    if (!names.length) {
      result = { found: false };
    } else {
      const response = await fetch(fileUrl(names[0]));
      if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`);
      result = {
        found: true,
        name: names[0],
        mime: response.headers.get('content-type') ?? '',
        data: toBase64(await response.arrayBuffer()),
      };
    }
  } catch (error) {
    // Rate limiting or a network blip: report it, but don't cache a failure that may pass.
    return { found: false, error: String(error?.message ?? error) };
  }

  audioCache.set(key, result);
  while (audioCache.size > MAX_CACHED_AUDIO) audioCache.delete(audioCache.keys().next().value);
  return result;
}

// --- Anki -------------------------------------------------------------------

const anki = createClient();

/** Fetch the audio for a card without re-downloading it if it's already cached. */
async function audioFor(card) {
  const result = await handleAudio({ word: card.headword, pinyin: card.pinyin });
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
  const notes = cards.map((card) => ({
    deckName: settings.ankiDeck,
    modelName: settings.ankiModel,
    fields: buildFields(mapping, card),
    options: { allowDuplicate: false },
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

  // Only bother fetching audio when a field actually wants it.
  let audioFilename = '';
  if (Object.values(mapping).includes('audio')) {
    const audio = await audioFor(card);
    if (audio) {
      const extension = audio.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.mp3';
      // Named so notes from this extension are distinguishable from other sources'.
      audioFilename = await anki.storeMedia(`${card.headword}_miaoyixia_zh-CN${extension}`, audio.data);
    }
  }

  const noteId = await anki.addNote({
    deckName: settings.ankiDeck,
    modelName: settings.ankiModel,
    fields: buildFields(mapping, card, { audioFilename }),
    tags: settings.ankiTags.split(/\s+/).filter(Boolean),
    options: { allowDuplicate: false },
  });

  return { noteId, created, audio: Boolean(audioFilename), deck: settings.ankiDeck };
}

const HANDLERS = {
  lookup: handleLookup,
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;

  // Promise.resolve rather than handler(...).then: a handler that does no I/O is allowed to be
  // an ordinary function, and one that throws synchronously must still answer. Without this,
  // either case kills the message port and surfaces at the caller as a bare
  // "handler(...).then is not a function" with no clue which message caused it.
  Promise.resolve()
    .then(() => handler(message))
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
// Left click toggles the extension; the right-click menu holds the rest. A button can have a
// popup or an onClicked handler but not both, and one-click disabling is worth more here than
// a panel would be.

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

chrome.action.onClicked.addListener(async () => {
  const { enabled } = await getSettings();
  await chrome.storage.sync.set({ enabled: !enabled });
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
