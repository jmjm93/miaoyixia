// CC-CEDICT stores pinyin in ASCII with trailing tone digits ("ni3 hao3", "lu:4").
// The popup shows proper diacritics, so we convert at runtime and keep the tone
// numbers alongside -- they drive tone colouring, and study-card output wants them.

const TONE_MARKS = {
  a: 'āáǎàa',
  e: 'ēéěèe',
  i: 'īíǐìi',
  o: 'ōóǒòo',
  u: 'ūúǔùu',
  ü: 'ǖǘǚǜü',
};

/**
 * Which vowel in a syllable carries the tone mark.
 * Standard rule: 'a' or 'e' wins outright; in "ou" the 'o' takes it;
 * otherwise it lands on the last vowel.
 */
function toneTarget(vowels) {
  const a = vowels.indexOf('a');
  if (a !== -1) return a;
  const e = vowels.indexOf('e');
  if (e !== -1) return e;
  const ou = vowels.indexOf('ou');
  if (ou !== -1) return ou;
  return vowels.length - 1;
}

/**
 * Convert one numbered syllable to diacritics.
 * @returns {{text: string, tone: number}} tone is 1-4, or 5 for neutral/unmarked.
 */
export function convertSyllable(syllable) {
  // u: and v are both used for ü.
  const normalised = syllable.replace(/u:/g, 'ü').replace(/v/g, 'ü').replace(/V/g, 'Ü');
  const match = /^(.*?)([1-5])$/.exec(normalised);
  if (!match) return { text: normalised, tone: 0 };

  const [, body, digit] = match;
  const tone = Number(digit);
  if (tone === 5) return { text: body, tone };

  // Find the vowel cluster the mark belongs to.
  const vowels = /[aeiouüAEIOUÜ]+/.exec(body);
  if (!vowels) return { text: body, tone };

  const cluster = vowels[0];
  const offset = vowels.index + toneTarget(cluster.toLowerCase());
  const vowel = body[offset];
  const marks = TONE_MARKS[vowel.toLowerCase()];
  if (!marks) return { text: body, tone };

  const marked = marks[tone - 1];
  const cased = vowel === vowel.toUpperCase() ? marked.toUpperCase() : marked;
  return { text: body.slice(0, offset) + cased + body.slice(offset + 1), tone };
}

/**
 * Convert a whole numbered pinyin string.
 * Non-syllable tokens (middots, Latin abbreviations, punctuation) pass through
 * untouched with tone 0 so the caller can style them neutrally.
 * @returns {{text: string, syllables: Array<{text: string, tone: number}>}}
 */
export function toDiacritics(pinyin) {
  const syllables = pinyin
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => convertSyllable(token));
  return { text: syllables.map((s) => s.text).join(' '), syllables };
}
