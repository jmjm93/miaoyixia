// Turns a dictionary entry into Anki field values.
//
// Nothing here knows any particular field, note type or deck name. The caller supplies a
// mapping of {field name -> token id}, and each token is a small pure function of the card.
// That is what lets the extension adapt to whatever collection it finds: the shipped defaults
// merely pre-fill the mapping, they aren't assumed anywhere.

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
 * Every value a field can be bound to. `label` is what the options page shows.
 * @type {Array<{id: string, label: string, render: (card: object, extras: object) => string}>}
 */
export const TOKENS = [
  { id: 'none', label: '— leave empty —', render: () => '' },
  { id: 'headword', label: 'Word (as hovered)', render: (c) => escapeHtml(c.headword) },
  { id: 'simplified', label: 'Simplified', render: (c) => escapeHtml(c.simplified) },
  { id: 'traditional', label: 'Traditional', render: (c) => escapeHtml(c.traditional) },
  { id: 'colourHanzi', label: 'Word, tone-coloured', render: colouredHanzi },
  { id: 'pinyin', label: 'Pinyin (nǐ hǎo)', render: (c) => escapeHtml(c.pinyin) },
  { id: 'colourPinyin', label: 'Pinyin, tone-coloured', render: colouredPinyin },
  { id: 'pinyinNumbered', label: 'Pinyin, numbered (ni3 hao3)', render: (c) => escapeHtml(c.pinyinNumbered) },
  {
    id: 'senses',
    label: 'All definitions',
    render: (c) => c.senses.map(escapeHtml).join('<br>'),
  },
  {
    id: 'sensesNumbered',
    label: 'All definitions, numbered',
    render: (c) => c.senses.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join('<br>'),
  },
  { id: 'firstSense', label: 'First definition only', render: (c) => escapeHtml(c.senses[0] ?? '') },
  { id: 'sentence', label: 'Example sentence (from the page)', render: (c) => escapeHtml(c.sentence) },
  { id: 'sentenceBold', label: 'Example sentence, word in bold', render: sentenceWithWordBold },
  {
    id: 'audio',
    label: 'Pronunciation audio',
    // Filled by the caller once the media file has actually been stored in Anki.
    render: (_c, extras) => (extras.audioFilename ? `[sound:${extras.audioFilename}]` : ''),
  },
  {
    id: 'source',
    label: 'Source page (link)',
    render: (c) =>
      c.sourceUrl ? `<a href="${escapeHtml(c.sourceUrl)}">${escapeHtml(c.sourceTitle || c.sourceUrl)}</a>` : '',
  },
  { id: 'sourceUrl', label: 'Source page (plain URL)', render: (c) => escapeHtml(c.sourceUrl) },
];

const BY_ID = new Map(TOKENS.map((token) => [token.id, token]));

export function tokenExists(id) {
  return BY_ID.has(id);
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
