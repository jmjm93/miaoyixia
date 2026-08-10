// Normalises a raw CC-CEDICT row into the shape both the popup and (later) study-card
// exporters consume.
//
// The popup renders straight from this object. Keeping it a superset of what a flashcard
// needs -- both scripts, both pinyin forms, the sentence the word was found in, and the
// page it came from -- means adding an Anki exporter later is a new consumer of existing
// data rather than a change to the lookup path. See README "Anki export".

import { toDiacritics } from './pinyin.js';

// Longer CC-CEDICT glosses cross-reference other words with their pinyin in brackets,
// e.g. 打伞[da3 san3]. Left alone that puts raw tone digits in the middle of a definition,
// so bracketed runs that are clearly numbered pinyin get the same treatment as a headword's.
const BRACKETED = /\[([^\]]+)\]/g;
const PINYIN_TOKEN = /^[a-zA-ZüÜ:]+[1-5]?$/;

function looksLikePinyin(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.some((t) => /[1-5]$/.test(t)) && tokens.every((t) => PINYIN_TOKEN.test(t));
}

function renderSense(sense) {
  return sense.replace(BRACKETED, (match, inner) =>
    looksLikePinyin(inner) ? `[${toDiacritics(inner).text}]` : match,
  );
}

/**
 * @param {string} headword the form the user actually hovered
 * @param {string[]} row packed shard entry: [simplified, traditional|'', pinyin, senses]
 * @param {{sentence?: string, url?: string, title?: string}} [context]
 * @param {string[]|null} [translated] senses in the chosen gloss language, index-aligned with
 *   the English ones. Null when no translation is available for this entry -- which is normal,
 *   not an error: the gloss layer trails CC-CEDICT by a few hundred entries and gains none
 *   between releases. Falls back per sense rather than per entry, so a partly-translated entry
 *   still shows what it has.
 */
export function buildCard(headword, row, context = {}, translated = null) {
  const [simplified, traditional, numbered, senses] = row;
  const pinyin = toDiacritics(numbered);
  // Bracketed pinyin cross-references survive translation, so the same rendering applies
  // whichever language a sense is in.
  const english = senses.split('/');
  const shown = translated ? english.map((sense, i) => translated[i] || sense) : english;

  return {
    headword,
    /**
     * The form as it appeared on the page, kept even when `headword` is rewritten to the other
     * script for export. Only the page's own wording can be found in the page's own sentence.
     */
    hovered: headword,
    simplified,
    // Blank in the shard means "same as simplified"; callers shouldn't special-case it.
    traditional: traditional || simplified,
    hasVariants: Boolean(traditional) && traditional !== simplified,
    pinyin: pinyin.text,
    pinyinNumbered: numbered,
    syllables: pinyin.syllables,
    senses: shown.map(renderSense),
    /** Whether these senses came from the gloss layer rather than CC-CEDICT's English. */
    translated: Boolean(translated),
    sentence: context.sentence ?? '',
    sourceUrl: context.url ?? '',
    sourceTitle: context.title ?? '',
  };
}

/**
 * The same card with its headword forced to one script, for export.
 *
 * Someone who studies simplified but reads Taiwanese material -- or the reverse -- otherwise
 * ends up with a deck in two scripts depending on where each word was mined. `hovered` is left
 * alone, so the example sentence still bolds the form the page actually used.
 *
 * @param {object} card a buildCard() result
 * @param {'hovered'|'simplified'|'traditional'} preference
 */
export function applyScript(card, preference) {
  const wanted = preference === 'simplified' ? card.simplified : preference === 'traditional' ? card.traditional : '';
  // Tone colouring pairs each character with a syllable, and the two scripts are a per-character
  // mapping, so the pairing survives. A form that is missing or a different length would not,
  // and is left as it was rather than mangled.
  if (!wanted || wanted === card.headword || [...wanted].length !== [...card.headword].length) return card;
  return { ...card, headword: wanted };
}
