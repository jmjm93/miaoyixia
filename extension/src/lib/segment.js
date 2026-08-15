// Splitting a recognised line into words.
//
// Chinese is written without spaces, so a line read off an image is one run of characters and
// something has to decide where the words are. Hovering never needed this -- the cursor says
// where the word starts, and the dictionary says how far it runs -- but a snip hands over a
// whole sentence with no such anchor.
//
// The obvious algorithm is forward maximum matching: take the longest dictionary word from the
// left, advance, repeat. It is four lines and it is wrong often enough to matter, because a
// greedy first choice can strand everything after it:
//
//   研究生命起源   greedy -> 研究生 | 命 | 起源     ("graduate student", "life")
//                  wanted -> 研究 | 生命 | 起源     ("research", "origin of life")
//
// So instead every position is a node, every dictionary match is an edge, and the segmentation
// is the cheapest path across. Same O(n · maxWordLength) work as maximum matching, but nothing
// is committed until the whole line has been considered.
//
// The costs below are what stand in for word frequencies, which CC-CEDICT does not carry. If a
// frequency table is ever added, this stays exactly as it is and TOKEN becomes -log P(word).

/** A dictionary word. Fewer, longer words is the right prior for Chinese. */
const TOKEN = 1;

/**
 * Extra cost for a one-character word.
 *
 * This is the rule that earns its keep. In the example above both segmentations are three
 * tokens, so counting alone ties -- and the tie is broken by the greedy one having stranded 命
 * on its own. Without this the DP is barely better than maximum matching.
 */
const SINGLE = 0.5;

/**
 * A character the dictionary does not know: punctuation, latin, or whatever OCR made up. Priced
 * above a known single character so it is never preferred, but finite, so an unreadable glyph
 * costs one token rather than dragging its neighbours into a worse split.
 */
const UNKNOWN = 2;

/**
 * Choose where the words are.
 *
 * Pure, and deliberately ignorant of the dictionary: it is given only how long the text is and
 * which lengths are words at each position, so it can be tested against a fake dictionary.
 *
 * @param {number} length Number of characters in the text.
 * @param {Array<number[]>} wordLengthsAt For each character position, the lengths of dictionary
 *   words starting there. May be empty. Order does not matter.
 * @returns {Array<{start: number, length: number}>} Tokens, in reading order, covering the text.
 */
export function segment(length, wordLengthsAt) {
  if (length <= 0) return [];

  // cost[i] is the cheapest way to cover everything from i onwards; take[i] is the token length
  // that achieves it. Solved back to front so each step only reads answers it already has.
  const cost = new Float64Array(length + 1);
  const take = new Int32Array(length + 1);

  for (let i = length - 1; i >= 0; i--) {
    // The fallback is always available: one unknown character, whatever the dictionary thinks.
    // Without it a position with no matches would have no finite cost and the DP would break.
    let best = UNKNOWN + cost[i + 1];
    let chosen = 1;

    // Longest first, with a strict comparison below, so ties resolve to the longer word.
    const lengths = [...(wordLengthsAt[i] ?? [])].sort((a, b) => b - a);
    for (const wordLength of lengths) {
      if (wordLength < 1 || i + wordLength > length) continue;
      const candidate = TOKEN + (wordLength === 1 ? SINGLE : 0) + cost[i + wordLength];
      if (candidate < best) {
        best = candidate;
        chosen = wordLength;
      }
    }

    cost[i] = best;
    take[i] = chosen;
  }

  const tokens = [];
  for (let i = 0; i < length; i += take[i]) {
    tokens.push({ start: i, length: take[i] });
  }
  return tokens;
}
