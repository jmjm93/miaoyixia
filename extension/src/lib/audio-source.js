// Finds human pronunciation recordings on Wikimedia Commons.
//
// Commons holds thousands of freely-licensed Mandarin recordings (mostly from Lingua Libre),
// but there is no "give me the audio for this word" endpoint -- only a title search. Two
// things therefore have to be got right:
//
//   Language. A search for 中国 also returns Cantonese, Japanese and Min Nan recordings of
//   the same characters. Filenames carry the language, so they are filtered on it.
//
//   Exactness. `intitle:` matches substrings, so 中国 also matches 中国功夫 ("Chinese kung
//   fu"), 他 matches 奥司他韦 ("oseltamivir"), and 打 matches 打嘴巴. Playing the wrong word
//   is worse than playing nothing, so the word encoded in the filename must match exactly.

const SEARCH_API = 'https://commons.wikimedia.org/w/api.php';
/** Redirects to the real upload URL, so no second API round trip is needed. */
const FILE_PATH = 'https://commons.wikimedia.org/wiki/Special:FilePath/';
const SEARCH_LIMIT = 50;

const AUDIO_EXT = /\.(ogg|oga|opus|wav|mp3|flac)$/i;

// Q9192 is Mandarin; Q727694 is Taiwanese Mandarin. `(cmn)` and a leading `Zh-` also mark it.
const MANDARIN = /^zh[-_ ]|\(cmn\)|LL-Q9192|LL-Q727694/i;
// Other Sinitic languages and other languages entirely, which share the same characters.
const NOT_MANDARIN = /zh[-_]yue|\((yue|nan|hak|wuu|cdo|cjy|hsn|gan|lzh)\)|LL-Q9186|LL-Q7850|^(ja|ko|vi|th)[-_ ]/i;

/**
 * Contributors don't all use an ASCII hyphen as the separator: "LL-Q9192—Yug—个.wav" uses em
 * dashes, and splitting on '-' alone finds the one inside "LL-Q9192" instead, yielding
 * "Q9192—Yug—个". Every variant here is a single UTF-16 code unit, so indexes found in the
 * normalised string still address the original -- which matters, because the *word* must be
 * sliced from the original in case it legitimately contains one of these.
 */
const DASHES = /[‐‑‒–—―−]/g;

function normaliseDashes(text) {
  return text.replace(DASHES, '-');
}

/**
 * The word a pronunciation file claims to say, or '' if the name doesn't follow a known
 * convention. Two conventions cover essentially everything on Commons:
 *   Lingua Libre  "LL-Q9192 (cmn)-Speaker-你好.wav"  -> 你好
 *   legacy        "Zh-你好.ogg" / "Zh nǐ hǎo.ogg"     -> 你好 / nǐ hǎo
 */
export function spokenTextOf(filename) {
  const base = filename.replace(/^File:/, '').replace(AUDIO_EXT, '');
  const dashed = normaliseDashes(base);

  if (/^LL-Q\d+/i.test(dashed)) {
    // Speaker names may contain hyphens and spaces; the word is always the final segment.
    const cut = dashed.lastIndexOf('-');
    return cut === -1 ? '' : base.slice(cut + 1).trim();
  }

  const legacy = /^zh(?:[-_ ](?:tw|cn|hans|hant))?[-_ ](.+)$/i.exec(dashed);
  // Matched against the normalised name, but returned from the original.
  return legacy ? base.slice(base.length - legacy[1].length).trim() : '';
}

/** Pinyin comparison has to survive case and spacing differences between contributors. */
function normalise(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:'"]+$/, '').trim();
}

/**
 * Does this file say exactly this word? Matching the entry's pinyin as well as its characters
 * both widens coverage (many legacy files are named in pinyin) and makes the result
 * reading-specific -- Zh-dǎ.ogg belongs to 打 "dǎ", not to 打 "dá".
 */
export function matchesWord(filename, word, pinyin = '') {
  if (!AUDIO_EXT.test(filename)) return false;
  // Language tags carry separators too, so they are read from the normalised name as well.
  const tagged = normaliseDashes(filename);
  if (!MANDARIN.test(tagged) || NOT_MANDARIN.test(tagged)) return false;

  const spoken = spokenTextOf(filename);
  if (!spoken) return false;
  return spoken === word || (Boolean(pinyin) && normalise(spoken) === normalise(pinyin));
}

/**
 * Candidate filenames for a word, best first.
 * @param {(url: string) => Promise<any>} getJson injected so this is testable offline
 */
export async function searchRecordings(word, pinyin, getJson) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: `intitle:${word} filetype:audio`,
    srnamespace: '6', // File:
    srlimit: String(SEARCH_LIMIT),
    format: 'json',
    formatversion: '2',
    origin: '*',
  });

  const json = await getJson(`${SEARCH_API}?${params}`);
  const titles = (json?.query?.search ?? []).map((hit) => String(hit.title).replace(/^File:/, ''));
  const exact = titles.filter((name) => matchesWord(name, word, pinyin));

  // Prefer Lingua Libre: those are deliberate single-word recordings by known speakers,
  // whereas legacy Zh- files are sometimes clipped from longer material.
  return exact.sort((a, b) => Number(/^LL-Q/i.test(b)) - Number(/^LL-Q/i.test(a)));
}

/**
 * The forms of a word worth searching for, best first and without duplicates.
 *
 * Lingua Libre's Mandarin campaign works from simplified word lists, so its filenames are
 * simplified even for words whose traditional form differs: 与 is recorded, 與 is not. Measured
 * over 25 common words where the two scripts differ, searching the traditional form as written
 * hit 4% where the simplified form hit 68%. The hovered form is still tried first -- it is what
 * the user asked for, and legacy Zh-tw- files do exist -- but stopping there loses most of the
 * coverage for anyone reading traditional text.
 */
export function searchForms({ word, simplified = '', traditional = '' }) {
  return [...new Set([word, simplified, traditional].filter(Boolean))];
}

export function fileUrl(filename) {
  return FILE_PATH + encodeURIComponent(filename.replace(/ /g, '_'));
}
