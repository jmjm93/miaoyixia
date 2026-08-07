// Options page. Every control writes straight to storage.sync on change; the content
// script picks changes up through storage.onChanged, so there is no Save button and no
// need to reload open tabs.
//
// Text comes from the string catalogue rather than the markup: options.html holds English as a
// readable fallback, and applyTranslations() replaces it. Changing the language re-runs that
// pass, so it takes effect without a reload like every other setting here.

import { DEFAULT_SETTINGS, HOVER_ONLY, getSettings } from '../lib/settings.js';
import { TOKENS, tokenLabel } from '../lib/anki-fields.js';
import {
  GLOSS_ORIGIN,
  GLOSS_SOURCES,
  downloadGlosses,
  glossInfo,
  hasGlossPermission,
  requestGlossPermission,
} from '../lib/gloss-store.js';
import { LANGUAGES, language, t, tn } from '../lib/i18n.js';

const ANKI_ORIGINS = ['http://127.0.0.1:8765/*', 'http://localhost:8765/*'];

/** Controls whose value is a number rather than a string. */
const NUMERIC = new Set(['fontSize', 'maxSenses', 'hoverDelay', 'speechRate']);
/** Units appended to a range control's readout. */
const UNITS = { fontSize: 'px', hoverDelay: 'ms', speechRate: '×' };

/** Which catalogue key explains each audio source. */
const AUDIO_HINTS = {
  auto: 'audioHintAuto',
  voice: 'audioHintVoice',
  recording: 'audioHintRecording',
  off: 'audioHintOff',
};

/**
 * Entry count quoted in the "install a voice" note, as a claim about the bundled dictionary
 * rather than a live reading. The Dictionary section further down reports the real number from
 * the build; this only needs to make the point that a voice covers all of it.
 */
const BUNDLED_ENTRIES = 124766;

/** Choices that are meaningless without an installed Chinese TTS voice. */
const VOICE_DEPENDENT = ['auto', 'voice'];

/** Set by reportVoices(); drives which audio choices are offered. */
let hasChineseVoice = false;

/** Last successful getMeta result, kept so the line can be redrawn in another language. */
let dictMeta = null;
/** True once the dictionary build has been found missing, for the same reason. */
let dictError = false;

const saved = document.getElementById('saved');
let savedTimer = null;

function flashSaved() {
  saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { saved.hidden = true; }, 1200);
}

// --- translation ---------------------------------------------------------------

/**
 * Replace every marked node with the string for the current language.
 *
 * `data-i18n` sets textContent; `data-i18n-html` sets innerHTML, which a handful of strings need
 * for the <b> runs in the Windows voice instructions. Only ever fed catalogue strings, never
 * anything from a page or a collection.
 *
 * Idempotent, so it can simply be run again when the language changes.
 */
function applyTranslations() {
  document.documentElement.lang = language();

  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }

  // Carries the entry count, so it needs the number formatted for this language.
  document.getElementById('voiceHelpNote').innerHTML = t(
    'voiceHelpNote',
    BUNDLED_ENTRIES.toLocaleString(language()),
  );
}

/**
 * Redraw the four bits of text that report live state.
 *
 * They carry a `data-i18n` placeholder for their pre-answer value, which means applyTranslations
 * resets them to "Not checked", "Loading…" and so on. Anything already known has to be put back.
 */
function renderLiveText() {
  renderVoiceStatus();
  renderDictMeta();
  refreshGloss();
  // refreshAnki redraws the field rows itself; without it nothing else would.
  if (ankiEl.enabled.checked) refreshAnki();
  else renderFieldRows(modelFields ?? Object.keys(settings.ankiFields));
}

function renderDictMeta() {
  const el = document.getElementById('meta');
  if (dictError) {
    el.textContent = t('dictMissing');
    return;
  }
  if (!dictMeta) return; // still loading: the markup's "Loading…" is already correct
  const lang = language();
  el.textContent = t(
    'dictMeta',
    dictMeta.entries.toLocaleString(lang),
    dictMeta.headwords.toLocaleString(lang),
    dictMeta.release.slice(0, 10),
  );
}

// --- controls ------------------------------------------------------------------

function readControl(input) {
  if (input.type === 'checkbox') return input.checked;
  if (NUMERIC.has(input.id)) return Number(input.value);
  return input.value;
}

function writeControl(input, value) {
  if (input.type === 'checkbox') input.checked = Boolean(value);
  else input.value = String(value);

  // Range inputs mirror their value into the adjacent <output>.
  const out = document.getElementById(`${input.id}Out`);
  if (out) out.textContent = `${value}${UNITS[input.id] ?? ''}`;
}

/** Rows that only mean something for certain choices elsewhere on the page. */
function syncConditionalRows() {
  const hoverOnly = document.getElementById('triggerKey').value === HOVER_ONLY;
  document.getElementById('hoverDelayRow').hidden = !hoverOnly;

  const audio = document.getElementById('audio').value;
  document.getElementById('speechRateRow').hidden = audio === 'off';
  document.getElementById('audioHint').textContent = AUDIO_HINTS[audio] ? t(AUDIO_HINTS[audio]) : '';

  // Keyed on whether a voice exists rather than on the current choice: the instructions are
  // needed most when the voice options have just been greyed out.
  const showVoiceInfo = audio !== 'off';
  document.getElementById('voiceStatus').hidden = !showVoiceInfo;
  document.getElementById('voiceHelp').hidden = !showVoiceInfo || hasChineseVoice;
}

/**
 * Offer the voice-dependent choices only when a voice can actually serve them.
 *
 * 'voice' would simply fail without one, so a stored 'voice' is corrected in storage. 'auto'
 * already falls back to a recording, so it behaves correctly as-is and is left stored
 * untouched -- only *displayed* as the recording option it currently resolves to. Persisting
 * that coercion would strand the user on recordings-only after they install a voice, which is
 * the opposite of what they'd want.
 */
function syncVoiceDependentOptions() {
  const select = document.getElementById('audio');
  for (const value of VOICE_DEPENDENT) {
    select.querySelector(`option[value="${value}"]`).disabled = !hasChineseVoice;
  }

  if (hasChineseVoice) {
    select.value = settings.audio; // a voice appeared: honour the stored choice again
  } else if (settings.audio === 'voice') {
    settings.audio = 'recording';
    select.value = 'recording';
    chrome.storage.sync.set({ audio: 'recording' }).then(flashSaved);
  } else if (settings.audio === 'auto') {
    select.value = 'recording';
  }

  syncConditionalRows();
}

/** Report which Chinese voices the browser can see, in the current language. */
function renderVoiceStatus() {
  const status = document.getElementById('voiceStatus');
  const help = document.getElementById('voiceHelp');

  const chinese = speechSynthesis.getVoices().filter((voice) => /^zh\b|^zh-/i.test(voice.lang ?? ''));
  hasChineseVoice = chinese.length > 0;

  if (hasChineseVoice) {
    status.textContent = t('voiceFound', chinese.map((v) => `${v.name} [${v.lang}]`).join(', '));
    help.open = false;
  } else {
    status.textContent = t('voiceMissing');
    help.open = true;
  }

  syncVoiceDependentOptions();
}

/**
 * getVoices() fills in asynchronously, so listen for `voiceschanged` rather than trusting the
 * first, usually empty, answer.
 */
function reportVoices() {
  renderVoiceStatus();
  speechSynthesis.addEventListener('voiceschanged', renderVoiceStatus);
}

const settings = await getSettings();
applyTranslations();

// Name the Meta key after whatever the user's keyboard calls it. Rewriting the key rather than
// the text means a later language change still picks the Mac wording.
if (navigator.platform.startsWith('Mac')) {
  const option = document.getElementById('metaOption');
  option.dataset.i18n = 'holdCmd';
  option.textContent = t('holdCmd');
}

for (const key of Object.keys(DEFAULT_SETTINGS)) {
  const input = document.getElementById(key);
  if (!input) continue;

  writeControl(input, settings[key]);
  input.addEventListener('input', () => {
    const value = readControl(input);
    // Keep the in-memory copy in step: syncVoiceDependentOptions reads it to restore the
    // user's choice if a voice turns up later in the session.
    settings[key] = value;
    writeControl(input, value);
    syncConditionalRows();
    chrome.storage.sync.set({ [key]: value }).then(flashSaved);
  });
}

// Settings can now change from the toolbar button too, so mirror external edits rather than
// leaving a stale control on screen. writeControl fires no events, so this can't loop.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (newValue === undefined) continue;
    settings[key] = newValue;
    const input = document.getElementById(key);
    // Never rewrite the control the user is currently in: for a text field that would move
    // the caret to the end on every keystroke, since typing writes to storage as it goes.
    if (input && input !== document.activeElement) writeControl(input, newValue);
  }

  if (changes.glossLanguage) refreshGloss();

  // getSettings() is what pins the language, so re-read before repainting the text.
  if (changes.uiLanguage) {
    getSettings().then(() => {
      applyTranslations();
      renderLiveText();
      syncConditionalRows();
    });
    return;
  }

  syncConditionalRows();
  syncVoiceDependentOptions();
});

syncConditionalRows();
reportVoices();

// --- Anki ---------------------------------------------------------------------
//
// Deck, note type and every field name are read from the collection rather than assumed. The
// shipped defaults only pre-fill the inputs, so a different collection needs no code change.

const ankiEl = {
  enabled: document.getElementById('ankiEnabled'),
  deck: document.getElementById('ankiDeck'),
  model: document.getElementById('ankiModel'),
  deckList: document.getElementById('ankiDeckList'),
  modelList: document.getElementById('ankiModelList'),
  status: document.getElementById('ankiStatus'),
  permissionState: document.getElementById('ankiPermissionState'),
  permissionRow: document.getElementById('ankiPermissionRow'),
  statusRow: document.getElementById('ankiStatusRow'),
  grant: document.getElementById('ankiGrant'),
  retry: document.getElementById('ankiRetry'),
  table: document.getElementById('ankiFieldsTable'),
  note: document.getElementById('ankiFieldsNote'),
};

/** Field names of the note type currently typed in, or null while unknown. */
let modelFields = null;

function fillOptions(datalist, values) {
  datalist.replaceChildren();
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    datalist.append(option);
  }
}

/**
 * One row per field of the selected note type, each bound to a token.
 * Falls back to the configured mapping's own keys when the collection can't be read, so the
 * mapping stays editable while Anki is closed.
 */
function renderFieldRows(fields) {
  const body = ankiEl.table.querySelector('tbody');
  body.replaceChildren();

  for (const field of fields) {
    const row = document.createElement('tr');

    const label = document.createElement('th');
    label.textContent = field;
    label.scope = 'row';

    const cell = document.createElement('td');
    const select = document.createElement('select');
    for (const token of TOKENS) {
      const option = document.createElement('option');
      option.value = token.id;
      option.textContent = tokenLabel(token);
      select.append(option);
    }
    select.value = settings.ankiFields[field] ?? 'none';
    select.addEventListener('change', () => {
      settings.ankiFields = { ...settings.ankiFields, [field]: select.value };
      chrome.storage.sync.set({ ankiFields: settings.ankiFields }).then(flashSaved);
    });

    cell.append(select);
    row.append(label, cell);
    body.append(row);
  }

  ankiEl.note.hidden = fields.length > 0 === false;
}

async function hasAnkiPermission() {
  return chrome.permissions.contains({ origins: ANKI_ORIGINS });
}

/** Ask Anki for the collection's shape, and populate the dropdowns from it. */
async function refreshAnki() {
  const granted = await hasAnkiPermission();
  ankiEl.permissionState.textContent = t(granted ? 'granted' : 'notGranted');
  ankiEl.grant.hidden = granted;

  if (!granted) {
    ankiEl.status.textContent = t('grantFirst');
    renderFieldRows(Object.keys(settings.ankiFields));
    return;
  }

  ankiEl.status.textContent = t('checking');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ankiCollection' });
    if (!response?.ok) throw new Error(response?.error ?? 'no response');
    const { version, decks, models } = response.result;

    ankiEl.status.textContent = tn('ankiConnected', decks.length, version, decks.length);
    fillOptions(ankiEl.deckList, decks);
    fillOptions(ankiEl.modelList, models);

    // Only the chosen note type's real fields are worth offering.
    if (models.includes(settings.ankiModel)) {
      const fieldResponse = await chrome.runtime.sendMessage({ type: 'ankiFields', model: settings.ankiModel });
      modelFields = fieldResponse?.ok ? fieldResponse.result.fields : null;
      renderFieldRows(modelFields ?? Object.keys(settings.ankiFields));
    } else {
      // A note type that doesn't exist yet will be created from this very mapping.
      renderFieldRows(Object.keys(settings.ankiFields));
      ankiEl.status.textContent += t('ankiWillCreate', settings.ankiModel);
    }
  } catch (error) {
    ankiEl.status.textContent = t('ankiUnreachable', String(error.message ?? error));
    renderFieldRows(Object.keys(settings.ankiFields));
  }
}

// --- the downloadable gloss layer -------------------------------------------
//
// Definitions for any language other than English are fetched once and kept in IndexedDB. The
// list below the picker is always on screen, because whether a language is already here should
// be answerable *before* switching to it, not discovered afterwards.
//
// The download runs on this page rather than in the service worker for two reasons: the
// permission prompt needs a user gesture, and an MV3 worker can be killed mid-transfer.
// Extension pages share the worker's origin, so what is written here is what the worker reads.

const glossEl = {
  select: document.getElementById('glossLanguage'),
  list: document.getElementById('glossList'),
};

/** Every language definitions can be in. English is bundled; the rest are downloadable. */
const GLOSS_LANGUAGES = ['en', ...Object.keys(GLOSS_SOURCES)];

/** Approximate size of a gloss file, used only to turn bytes into a percentage. */
const GLOSS_BYTES = 10.3e6;

/**
 * Per-language state that storage can't answer: an in-flight download's progress, or why the
 * last attempt failed. Absent means "nothing happening, ask IndexedDB".
 * @type {Map<string, {progress?: number|null, error?: string}>}
 */
const glossActivity = new Map();

function glossName(lang) {
  return GLOSS_SOURCES[lang]?.name ?? LANGUAGES[lang] ?? lang;
}

function progressText(activity) {
  return activity.progress === null ? t('glossPreparing') : t('glossDownloading', activity.progress);
}

/** What one row should say, given everything known about that language right now. */
function glossRowState(lang, info, granted) {
  if (lang === 'en') return { key: 'bundled', text: t('glossBundled') };

  const activity = glossActivity.get(lang);
  if (activity?.progress !== undefined) return { key: 'downloading', text: progressText(activity) };
  if (activity?.error) {
    return { key: 'failed', text: t('glossFailed', activity.error), action: 'download' };
  }

  if (info?.version === GLOSS_SOURCES[lang]?.version) {
    const when = new Date(info.downloadedAt).toLocaleDateString(language());
    return {
      key: 'ready',
      text: t('glossDownloaded', info.entries.toLocaleString(language()), when),
      action: 'remove',
    };
  }
  // A layer built against an older CC-CEDICT is treated as absent rather than used, so the row
  // has to say so instead of reporting everything is fine.
  if (info) return { key: 'stale', text: t('glossUpdate'), action: 'download' };
  return {
    key: 'missing',
    text: granted ? t('glossNotDownloaded') : t('glossNeedsPermission'),
    action: 'download',
  };
}

async function refreshGloss() {
  const granted = await hasGlossPermission();
  const infos = await Promise.all(GLOSS_LANGUAGES.map((lang) => (lang === 'en' ? null : glossInfo(lang))));

  glossEl.list.replaceChildren();
  for (const [i, lang] of GLOSS_LANGUAGES.entries()) {
    const state = glossRowState(lang, infos[i], granted);

    const li = document.createElement('li');
    li.dataset.state = state.key;
    li.dataset.lang = lang;
    // Marks where the definitions are actually coming from, which is not always the row the
    // user last clicked: picking a language it hasn't finished downloading still reads English.
    if (lang === settings.glossLanguage) li.dataset.active = '';

    const label = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = glossName(lang);
    const status = document.createElement('small');
    status.className = 'state';
    status.textContent = state.text;
    label.append(name, status);
    li.append(label);

    if (state.action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t(state.action === 'remove' ? 'glossRemove' : 'glossDownload');

      // Removing the layer the definitions are currently coming from would silently drop every
      // lookup back to English, with the picker still insisting on Spanish -- a state that
      // looks like a bug rather than a choice. Disabled rather than hidden, with the way out
      // in the tooltip, so the button explains itself instead of vanishing.
      const removingActive = state.action === 'remove' && lang === settings.glossLanguage;
      if (removingActive) {
        button.disabled = true;
        button.title = t('glossRemoveActive');
      }

      button.addEventListener('click', () =>
        state.action === 'remove' ? removeGloss(lang) : startGlossDownload(lang),
      );
      li.append(button);
    }
    glossEl.list.append(li);
  }
}

async function removeGloss(lang) {
  await chrome.runtime.sendMessage({ type: 'glossClear', language: lang });
  glossActivity.delete(lang);
  await refreshGloss();
}

/** Whether this language's stored layer matches the version this build expects. */
async function glossDownloaded(lang) {
  const info = await glossInfo(lang);
  return info?.version === GLOSS_SOURCES[lang]?.version;
}

/**
 * Fetch a language's definitions, reporting progress into its row.
 *
 * Returns immediately if that language is already downloading, which matters because two paths
 * lead here: the row's own button, and switching the picker to a language that isn't here yet.
 */
async function startGlossDownload(lang) {
  if (glossActivity.get(lang)?.progress !== undefined) return;

  // Requested here because a permission prompt needs a user gesture, and both callers are one:
  // a click on the button, or a change on the picker.
  if (!(await hasGlossPermission()) && !(await requestGlossPermission())) {
    glossActivity.set(lang, { error: t('glossNeedsPermission') });
    await refreshGloss();
    return;
  }

  glossActivity.set(lang, { progress: 0 });
  await refreshGloss();

  try {
    await downloadGlosses(lang, (bytes) => {
      const activity = { progress: bytes === null ? null : Math.min(99, Math.round((bytes / GLOSS_BYTES) * 100)) };
      glossActivity.set(lang, activity);
      // Rebuilding the whole list on every chunk would thrash the DOM and drop focus; the one
      // row that changed is enough.
      const status = glossEl.list.querySelector(`li[data-lang="${lang}"] .state`);
      if (status) status.textContent = progressText(activity);
    });
    glossActivity.delete(lang);
    // The worker memoises whether a layer is ready; tell it to look again.
    await chrome.runtime.sendMessage({ type: 'glossChanged' });
  } catch (error) {
    glossActivity.set(lang, { error: String(error?.message ?? error) });
  }
  await refreshGloss();
}

/**
 * Switching the picker to a language that isn't here yet starts fetching it.
 *
 * The setting is written either way, by the generic control handler above. Until the data
 * lands, lookups answer in English and the popup says so -- a slow or failed download degrades
 * to the previous behaviour rather than to a broken one.
 */
glossEl.select.addEventListener('change', async () => {
  const lang = glossEl.select.value;
  await refreshGloss();
  if (lang !== 'en' && !(await glossDownloaded(lang))) startGlossDownload(lang);
});

// Revoking the permission elsewhere (chrome://extensions) should be reflected here.
chrome.permissions.onRemoved?.addListener(({ origins = [] }) => {
  if (origins.some((origin) => origin.startsWith(GLOSS_ORIGIN))) refreshGloss();
});

ankiEl.grant.addEventListener('click', async () => {
  // Must be called from a user gesture, which is why this lives on a button.
  const granted = await chrome.permissions.request({ origins: ANKI_ORIGINS });
  if (granted) refreshAnki();
});

ankiEl.retry.addEventListener('click', refreshAnki);

// Re-reading the field list is only worth it once the typed name settles.
ankiEl.model.addEventListener('change', refreshAnki);

function syncAnkiRows() {
  const on = ankiEl.enabled.checked;
  for (const el of ankiEl.table.closest('main').querySelectorAll('#ankiFieldsTable, #ankiFieldsNote')) {
    el.hidden = !on;
  }
  ankiEl.permissionRow.hidden = !on;
  ankiEl.statusRow.hidden = !on;
  for (const id of ['ankiDeck', 'ankiModel', 'ankiTags']) {
    document.getElementById(id).closest('.row').hidden = !on;
  }
  document.querySelector('h3').hidden = !on;
}

ankiEl.enabled.addEventListener('change', () => {
  syncAnkiRows();
  if (ankiEl.enabled.checked) refreshAnki();
});

syncAnkiRows();
if (ankiEl.enabled.checked) refreshAnki();
// Awaited, unlike refreshAnki above: it reads IndexedDB, so firing it and moving on would let
// the page announce itself ready with the language list still empty.
await refreshGloss();

// Report what the bundled dictionary actually contains, so a stale or missing build is obvious.
try {
  const response = await chrome.runtime.sendMessage({ type: 'getMeta' });
  if (!response?.ok) throw new Error(response?.error ?? 'no response');
  dictMeta = response.result;
  renderDictMeta();
} catch {
  dictError = true;
  renderDictMeta();
}

// Everything above is top-level await, so this is the point at which the page is fully settled:
// translated, controls populated, voices reported and the dictionary asked about. The browser
// tests wait on it rather than guessing at a particular string having appeared.
document.body.dataset.ready = '';
