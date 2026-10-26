// Small, dictionary-driven Japanese lookup. No tokenizer or remote lookup service.
// Rules cover common polite, negative, past and te forms; dictionary POS tags validate them.
import { SHARD_COUNT, shardFor } from './shard.js';

const applies = (values, form) => values?.includes('*') || values?.includes(form);

/** Preserve spelling/reading/sense restrictions when compiling JMdict's JSON distribution. */
export function buildJapaneseDictionary(dictionary) {
  if (!Array.isArray(dictionary?.words) || !dictionary.words.length || !dictionary.languages?.includes('eng')) {
    throw new Error('Downloaded file is not an English JMdict dictionary');
  }
  const shards = Array.from({ length: SHARD_COUNT }, () => ({}));
  let rows = 0;
  let maxWordLength = 0;
  for (const entry of dictionary.words) {
    if (!entry.id || !Array.isArray(entry.kanji) || !Array.isArray(entry.kana) || !Array.isArray(entry.sense)) {
      throw new Error('Invalid JMdict entry');
    }
    for (const kana of entry.kana) {
      if (typeof kana.text !== 'string' || !kana.text) throw new Error('Invalid JMdict reading');
      const forms = [kana.text, ...entry.kanji.filter((kanji) => applies(kana.appliesToKanji, kanji.text)).map((k) => k.text)];
      for (const form of new Set(forms)) {
        const senses = entry.sense.filter((sense) =>
          applies(sense.appliesToKana, kana.text) &&
          (form === kana.text || applies(sense.appliesToKanji, form)),
        );
        const glosses = senses.flatMap((sense) => sense.gloss.filter((gloss) => gloss.lang === 'eng').map((g) => g.text));
        if (!glosses.length) continue;
        const row = {
          id: entry.id, word: form, reading: kana.text, senses: glosses,
          pos: [...new Set(senses.flatMap((sense) => sense.partOfSpeech))],
          common: kana.common || entry.kanji.some((k) => k.text === form && k.common),
        };
        (shards[shardFor(form)][form] ??= []).push(row);
        maxWordLength = Math.max(maxWordLength, [...form].length);
        rows++;
      }
    }
  }
  if (!rows) throw new Error('JMdict contains no usable entries');
  return { shards, meta: { entries: dictionary.words.length, rows, maxWordLength, date: dictionary.dictDate } };
}

// Independent rules, intentionally limited rather than pretending to be a full grammar engine.
const RULES = [];
const add = (suffix, replacement, pos) => RULES.push({ suffix, replacement, pos });
for (const suffix of ['ました', 'ませんでした', 'ません', 'ます', 'なかった', 'ない', 'た', 'て']) {
  add(suffix, 'る', 'v1');
}
const godan = [['い', 'う'], ['き', 'く'], ['ぎ', 'ぐ'], ['し', 'す'], ['ち', 'つ'], ['に', 'ぬ'], ['び', 'ぶ'], ['み', 'む'], ['り', 'る']];
for (const [stem, ending] of godan) {
  for (const polite of ['ました', 'ませんでした', 'ません', 'ます']) add(stem + polite, ending, 'v5' + ending);
}
for (const [stem, ending] of [['わ', 'う'], ['か', 'く'], ['が', 'ぐ'], ['さ', 'す'], ['た', 'つ'], ['な', 'ぬ'], ['ば', 'ぶ'], ['ま', 'む'], ['ら', 'る']]) {
  for (const suffix of ['ない', 'なかった']) add(stem + suffix, ending, 'v5' + ending);
}
for (const [suffix, endings] of [['った', ['う', 'つ', 'る']], ['って', ['う', 'つ', 'る']], ['いた', ['く']], ['いて', ['く']], ['いだ', ['ぐ']], ['いで', ['ぐ']], ['んだ', ['む', 'ぶ', 'ぬ']], ['んで', ['む', 'ぶ', 'ぬ']], ['した', ['す']], ['して', ['す']]]) {
  for (const ending of endings) add(suffix, ending, 'v5' + ending);
}
for (const suffix of ['かった', 'くない', 'くなかった', 'くて']) add(suffix, 'い', 'adj-i');
for (const suffix of ['した', 'して', 'します', 'しました', 'しない', 'しなかった', 'しません', 'しませんでした']) add(suffix, 'する', 'vs');
for (const suffix of ['きた', 'きて', 'きます', 'きました', 'こない', 'こなかった', 'きません', 'きませんでした']) add(suffix, 'くる', 'vk');
for (const suffix of ['た', 'て', 'ます', 'ました', 'ない', 'なかった', 'ません', 'ませんでした']) add('来' + suffix, '来る', 'vk');
for (const suffix of ['った', 'って']) add('行' + suffix, '行く', 'v5k');

const GODAN_TAG = { 'う': 'u', 'く': 'k', 'ぐ': 'g', 'す': 's', 'つ': 't', 'ぬ': 'n', 'ぶ': 'b', 'む': 'm', 'る': 'r' };
function accepts(row, wanted) {
  if (!wanted) return true;
  const tag = wanted.startsWith('v5') ? 'v5' + (GODAN_TAG[wanted.slice(2)] ?? wanted.slice(2)) : wanted;
  return row.pos.some((pos) => pos === tag || pos.startsWith(tag + '-') || (tag === 'vs' && pos.startsWith('vs')));
}

export function japaneseForms(surface) {
  const forms = [{ word: surface, pos: null }];
  // One progressive layer can be removed before ordinary conjugation rules.
  const bases = [surface];
  for (const ending of ['いる', 'います', 'いました', 'いた', 'いない']) {
    if (surface.endsWith(ending) && /[てで]$/.test(surface.slice(0, -ending.length))) {
      bases.push(surface.slice(0, -ending.length));
    }
  }
  for (const base of bases) {
    for (const rule of RULES) {
      if (base.endsWith(rule.suffix)) forms.push({ word: base.slice(0, -rule.suffix.length) + rule.replacement, pos: rule.pos });
    }
  }
  return forms;
}

/** The consumed length stays that of the surface text, even when the lemma is shorter. */
export async function japaneseMatches(text, loadShard, maxWordLength = 40) {
  const chars = [...text];
  const candidates = [];
  for (let length = Math.min(chars.length, maxWordLength + 12); length >= 1; length--) {
    const surface = chars.slice(0, length).join('');
    if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ]+$/u.test(surface)) continue;
    const seen = new Set();
    const entries = [];
    for (const form of japaneseForms(surface)) {
      const shard = await loadShard(shardFor(form.word));
      for (const row of shard?.[form.word] ?? []) {
        const key = `${row.id}\t${row.word}\t${row.reading}`;
        if (!seen.has(key) && accepts(row, form.pos)) { seen.add(key); entries.push(row); }
      }
    }
    if (entries.length) candidates.push({ headword: surface, length, entries: entries.sort((a, b) => Number(b.common) - Number(a.common)) });
  }
  return candidates;
}

export function buildJapaneseCard(surface, row, context = {}) {
  return {
    language: 'ja', headword: row.word, hovered: surface, reading: row.reading,
    senses: row.senses, sentence: context.sentence ?? '', sourceUrl: context.url ?? '', sourceTitle: context.title ?? '',
  };
}
