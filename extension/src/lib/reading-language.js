/** Conservative local evidence: shared Han words remain ambiguous. */
export function languageEvidence(text = '') {
  // Ignore quoted fragments so a Japanese word quoted in Chinese does not decide the sentence.
  const context = text.replace(/[「『“"].*?[」』”"]/gu, '');
  if (/[\u3041-\u3096\u30a1-\u30fa]/u.test(context)) return 'ja';
  if (/[这们吗呢没让从说话为与个]/u.test(context) || /(?:的|了|是|在|不|有|我|你|他|她).*(?:的|了|是|在|不|有|我|你|他|她)/u.test(context)) return 'zh';
  return null;
}

/** Prefer coverage by multi-character words; individual shared Han entries prove little. */
export function dictionaryCoverage(text, matchesAt) {
  const length = [...text].length;
  if (!length) return 0;
  const scores = Array(length + 1).fill(0);
  for (let i = length - 1; i >= 0; i--) {
    scores[i] = scores[i + 1];
    for (const match of matchesAt[i] ?? []) {
      if (match.length > 1 && i + match.length <= length) {
        scores[i] = Math.max(scores[i], match.length + scores[i + match.length]);
      }
    }
  }
  return scores[0] / length;
}
