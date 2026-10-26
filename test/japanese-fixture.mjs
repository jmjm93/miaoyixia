import { gzipSync } from 'node:zlib';

export function word(id, spelling, reading, gloss, pos = ['n']) {
  return {
    id,
    kanji: spelling === reading ? [] : [{ text: spelling, common: true, tags: [] }],
    kana: [{ text: reading, common: true, tags: [], appliesToKanji: ['*'] }],
    sense: [{ appliesToKanji: ['*'], appliesToKana: ['*'], partOfSpeech: pos, gloss: [{ lang: 'eng', text: gloss }] }],
  };
}
export const JAPANESE_FIXTURE = {
  languages: ['eng'], dictDate: '2026-10-05',
  words: [
    word('1', '食べる', 'たべる', 'to eat', ['v1']),
    word('2', '読む', 'よむ', 'to read', ['v5m']),
    word('3', '高い', 'たかい', 'high', ['adj-i']),
    word('4', '学校', 'がっこう', 'school'),
    word('5', 'ありがとう', 'ありがとう', 'thank you', ['int']),
    word('6', 'コーヒー', 'コーヒー', 'coffee'),
    word('7', '私', 'わたし', 'I'),
    word('8', 'は', 'は', 'topic marker', ['prt']),
    word('9', 'を', 'を', 'object marker', ['prt']),
    word('10', 'する', 'する', 'to do', ['vs-i']),
    word('11', '来る', 'くる', 'to come', ['vk']),
    word('12', '行く', 'いく', 'to go', ['v5k-s']),
  ],
};

export function archiveFor(dictionary = JAPANESE_FIXTURE) {
  const data = Buffer.from(JSON.stringify(dictionary));
  const header = Buffer.alloc(512);
  header.write('fixture.json');
  header.write(data.length.toString(8).padStart(11, '0'), 124, 'ascii');
  header[156] = 48;
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]));
}

export function fakeModel() {
  const data = Buffer.alloc(100_000);
  data.writeInt32LE(24);
  for (let i = 0; i < 24; i++) data.writeBigInt64LE(-1n, 4 + 8 * i);
  data.writeBigInt64LE(196n, 4);
  return data;
}
