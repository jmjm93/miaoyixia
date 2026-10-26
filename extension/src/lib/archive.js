// The optional dictionary is a gzip-compressed tar containing one JSON file.
// Decode data only; no remote JavaScript or archive paths are ever installed.
export async function dictionaryFromArchive(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/s, '');
    const size = parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) {
      throw new Error('Truncated dictionary archive');
    }
    if (name.endsWith('.json') && (header[156] === 0 || header[156] === 48)) {
      return JSON.parse(decoder.decode(tar.subarray(offset + 512, offset + 512 + size)));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('No dictionary JSON in archive');
}
