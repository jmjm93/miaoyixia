// Turns a dictionary entry into Anki field values.
//
// Nothing here knows any particular field, note type or deck name. The caller supplies a
// mapping of {field name -> token id}, and each token is a small pure function of the card.
// That is what lets the extension adapt to whatever collection it finds: the shipped defaults
// merely pre-fill the mapping, they aren't assumed anywhere.

import { t } from './i18n.js';

/** Anki fields are HTML, so anything derived from dictionary text has to be escaped. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Anki card templates conventionally style .tone1-.tone5; anything else has no rule. */
function toneClass(tone) {
  return tone >= 1 && tone <= 5 ? `tone${tone}` : 'tone5';
}

/**
 * One tone-coloured span per character.
 *
 * Tones are per *syllable* while the colouring is per *character*. They line up 1:1 for
 * ordinary Chinese, but not for headwords holding digits or Latin (卡拉OK, AA制). Emitting
 * plain text beats emitting confidently wrong colours, so a mismatch falls back.
 */
export function colouredHanzi(card) {
  const chars = [...card.headword];
  if (!card.syllables || chars.length !== card.syllables.length) return escapeHtml(card.headword);
  return chars
    .map((char, i) => `<span class="${toneClass(card.syllables[i].tone)}">${escapeHtml(char)}</span>`)
    .join('');
}

/** One tone-coloured span per syllable, with the toneless reading left in a comment. */
export function colouredPinyin(card) {
  if (!card.syllables?.length) return escapeHtml(card.pinyin);
  const spans = card.syllables
    .map((s) => `<span class="${toneClass(s.tone)}">${escapeHtml(s.text)}</span>`)
    .join(' ');
  // Matches the convention Chinese Support 3 writes, so notes look native alongside existing ones.
  const toneless = card.pinyinNumbered.replace(/[1-5](?=\s|$)/g, '').replace(/\s+/g, ' ').trim();
  return toneless ? `${spans} <!-- ${escapeHtml(toneless)} -->` : spans;
}

/** The sentence the word was found in, with that word emboldened. */
export function sentenceWithWordBold(card) {
  const sentence = escapeHtml(card.sentence);
  if (!card.sentence || !card.headword) return sentence;
  const word = escapeHtml(card.headword);
  return sentence.replace(word, `<b>${word}</b>`);
}

/**
 * Every value a field can be bound to.
 *
 * `labelKey` rather than a literal label: this array is built once at import, but the options
 * page can change language without reloading, so the text has to be resolved at render time.
 * Use tokenLabel() for that.
 *
 * @type {Array<{id: string, labelKey: string, render: (card: object, extras: object) => string}>}
 */
export const TOKENS = [
  { id: 'none', labelKey: 'tokenNone', render: () => '' },
  { id: 'headword', labelKey: 'tokenHeadword', render: (c) => escapeHtml(c.headword) },
  { id: 'simplified', labelKey: 'tokenSimplified', render: (c) => escapeHtml(c.simplified) },
  { id: 'traditional', labelKey: 'tokenTraditional', render: (c) => escapeHtml(c.traditional) },
  { id: 'colourHanzi', labelKey: 'tokenColourHanzi', render: colouredHanzi },
  { id: 'pinyin', labelKey: 'tokenPinyin', render: (c) => escapeHtml(c.pinyin) },
  { id: 'colourPinyin', labelKey: 'tokenColourPinyin', render: colouredPinyin },
  { id: 'pinyinNumbered', labelKey: 'tokenPinyinNumbered', render: (c) => escapeHtml(c.pinyinNumbered) },
  {
    id: 'senses',
    labelKey: 'tokenSenses',
    render: (c) => c.senses.map(escapeHtml).join('<br>'),
  },
  {
    id: 'sensesNumbered',
    labelKey: 'tokenSensesNumbered',
    render: (c) => c.senses.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join('<br>'),
  },
  { id: 'firstSense', labelKey: 'tokenFirstSense', render: (c) => escapeHtml(c.senses[0] ?? '') },
  { id: 'sentence', labelKey: 'tokenSentence', render: (c) => escapeHtml(c.sentence) },
  { id: 'sentenceBold', labelKey: 'tokenSentenceBold', render: sentenceWithWordBold },
  {
    id: 'audio',
    labelKey: 'tokenAudio',
    // Filled by the caller once the media file has actually been stored in Anki.
    render: (_c, extras) => (extras.audioFilename ? `[sound:${extras.audioFilename}]` : ''),
  },
  {
    id: 'source',
    labelKey: 'tokenSource',
    render: (c) =>
      c.sourceUrl ? `<a href="${escapeHtml(c.sourceUrl)}">${escapeHtml(c.sourceTitle || c.sourceUrl)}</a>` : '',
  },
  { id: 'sourceUrl', labelKey: 'tokenSourceUrl', render: (c) => escapeHtml(c.sourceUrl) },
];

const BY_ID = new Map(TOKENS.map((token) => [token.id, token]));

export function tokenExists(id) {
  return BY_ID.has(id);
}

/** The token's name in the language currently selected. */
export function tokenLabel(token) {
  return t(token.labelKey);
}

/**
 * Render a whole note.
 * @param {Record<string, string>} mapping field name -> token id
 * @param {object} card a buildCard() result
 * @param {{audioFilename?: string}} [extras]
 * @returns {Record<string, string>} field name -> HTML
 */
export function buildFields(mapping, card, extras = {}) {
  const fields = {};
  for (const [field, tokenId] of Object.entries(mapping)) {
    const token = BY_ID.get(tokenId);
    // An unknown token id (e.g. settings written by a newer version) yields an empty field
    // rather than throwing and losing the whole note.
    fields[field] = token ? token.render(card, extras) : '';
  }
  return fields;
}

/**
 * Which mapped field should go on the front of an auto-created note type.
 * Prefers whichever field holds the word itself; falls back to the first field.
 */
export function primaryField(mapping) {
  const order = ['headword', 'colourHanzi', 'simplified', 'traditional'];
  for (const wanted of order) {
    const found = Object.keys(mapping).find((field) => mapping[field] === wanted);
    if (found) return found;
  }
  return Object.keys(mapping)[0];
}
