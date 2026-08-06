// Options page. Every control writes straight to storage.sync on change; the content
// script picks changes up through storage.onChanged, so there is no Save button and no
// need to reload open tabs.

import { DEFAULT_SETTINGS, HOVER_ONLY, getSettings } from '../lib/settings.js';

/** Controls whose value is a number rather than a string. */
const NUMERIC = new Set(['fontSize', 'maxSenses', 'hoverDelay', 'speechRate']);
/** Units appended to a range control's readout. */
const UNITS = { fontSize: 'px', hoverDelay: 'ms', speechRate: '×' };

const AUDIO_HINTS = {
  auto: 'Uses an installed Chinese voice; falls back to a Wikimedia recording when there is none.',
  voice: 'Offline and instant, covers every entry — but needs a Chinese voice installed.',
  recording: 'Real speakers from Wikimedia Commons. Only common words have one.',
  off: 'Hides the play button entirely.',
};

/** Choices that are meaningless without an installed Chinese TTS voice. */
const VOICE_DEPENDENT = ['auto', 'voice'];

/** Set by reportVoices(); drives which audio choices are offered. */
let hasChineseVoice = false;

const saved = document.getElementById('saved');
let savedTimer = null;

function flashSaved() {
  saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { saved.hidden = true; }, 1200);
}

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
  document.getElementById('audioHint').textContent = AUDIO_HINTS[audio] ?? '';

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

/**
 * Report which Chinese voices the browser can see. getVoices() fills in asynchronously, so
 * this listens for `voiceschanged` rather than trusting the first, usually empty, answer.
 */
function reportVoices() {
  const status = document.getElementById('voiceStatus');
  const help = document.getElementById('voiceHelp');

  const render = () => {
    const chinese = speechSynthesis.getVoices().filter((voice) => /^zh\b|^zh-/i.test(voice.lang ?? ''));
    hasChineseVoice = chinese.length > 0;

    if (hasChineseVoice) {
      status.textContent = `Chinese voice found: ${chinese.map((v) => `${v.name} [${v.lang}]`).join(', ')}`;
      help.open = false;
    } else {
      status.textContent =
        'No Chinese voice is installed, so the computer-voice options are unavailable and ' +
        'Wikimedia recordings are being used instead. Installing a voice is worth it: it is ' +
        'the better option of the two — instant, fully offline, and it covers every entry in ' +
        'the dictionary, whereas Commons only has recordings for common words.';
      help.open = true;
    }

    syncVoiceDependentOptions();
  };

  render();
  speechSynthesis.addEventListener('voiceschanged', render);
}

const settings = await getSettings();

// Name the Meta key after whatever the user's keyboard calls it.
if (navigator.platform.startsWith('Mac')) document.getElementById('metaOption').textContent = 'Hold Cmd';

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

syncConditionalRows();
reportVoices();

// Report what the bundled dictionary actually contains, so a stale or missing build is obvious.
try {
  const response = await chrome.runtime.sendMessage({ type: 'getMeta' });
  if (!response?.ok) throw new Error(response?.error ?? 'no response');
  const meta = response.result;
  document.getElementById('meta').textContent =
    `${meta.entries.toLocaleString()} entries · ${meta.headwords.toLocaleString()} headwords · CC-CEDICT release ${meta.release.slice(0, 10)}`;
} catch {
  document.getElementById('meta').textContent =
    'Dictionary data not found — run `npm run build` in the project root, then reload the extension.';
}
