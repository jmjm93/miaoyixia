// Single source of truth for settings, shared by the service worker and options page.
// Passing this object to storage.sync.get() means missing keys come back as defaults,
// so no migration is needed when a new setting is added.

/**
 * Modifier that must be held while hovering, or 'none' to look up on hover alone.
 * The values other than 'none' are exactly the `KeyboardEvent.key` strings, so the
 * content script can compare against them directly.
 */
export const TRIGGER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'none'];

export const HOVER_ONLY = 'none';

export const DEFAULT_SETTINGS = {
  enabled: true,
  /** One of TRIGGER_KEYS. */
  triggerKey: 'Shift',
  /**
   * The modifier to return to when the toolbar menu's "require a key" item is ticked again.
   * `triggerKey` can't remember this itself once it has been set to 'none'.
   */
  lastModifier: 'Shift',
  /**
   * How long the pointer must rest on a word before a keyless lookup fires, in ms.
   * Only used when triggerKey is 'none' -- without a dwell the popup would flash open
   * on every word the pointer crosses on its way somewhere else.
   */
  hoverDelay: 300,
  /** Which script to show first when an entry has both. */
  script: 'simplified',
  /**
   * Where pronunciation audio comes from.
   *   'auto'      OS Chinese voice, falling back to a Wikimedia Commons recording
   *   'voice'     OS voice only -- offline, but needs a Chinese voice installed
   *   'recording' Commons recordings only -- real speakers, but patchy coverage
   *   'off'       no play button at all
   */
  audio: 'auto',
  /** Playback speed. Recordings are only ever slowed, never sped up. */
  speechRate: 0.9,

  /**
   * Anki export. Every name here is a *default*, not an assumption: the deck, the note type
   * and each field name are read from the user's collection at runtime and remapped in the
   * options page. Whatever is configured gets created on first use if it doesn't exist.
   */
  ankiEnabled: false,
  ankiDeck: 'Mandarin::Chinese Mining',
  ankiModel: 'Chinese (Basic)',
  /** field name -> token id, see anki-fields.js TOKENS */
  ankiFields: {
    Hanzi: 'headword',
    Color: 'colourHanzi',
    Pinyin: 'colourPinyin',
    English: 'senses',
    Sound: 'audio',
  },
  /** Space-separated, applied to every note the extension adds. */
  ankiTags: 'miao-yixia',

  /** 'auto' follows the OS colour scheme. */
  theme: 'auto',
  fontSize: 14,
  /** Senses beyond this are collapsed behind a "+n more" toggle. */
  maxSenses: 6,
};

export function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}
