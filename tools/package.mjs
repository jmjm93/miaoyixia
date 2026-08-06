// Builds a Chrome Web Store upload ZIP from extension/.
//
// Written by hand rather than shelling out to a zip tool because the obvious Windows options
// get it wrong: PowerShell's Compress-Archive (and .NET Framework's ZipFile) write entry names
// with backslashes, e.g. "data\meta.json". The ZIP spec requires forward slashes, and an
// archive like that can unpack as files literally named "data\meta.json" sitting at the root --
// at which point the extension is broken in a way that's baffling to debug.
//
// It also checks the two things that are easy to get wrong: manifest.json must sit at the ZIP
// root (not inside a folder), and the generated dictionary must actually be present, since
// extension/data/ is gitignored and a fresh clone won't have it.
//
//   node tools/package.mjs

import { deflateRawSync } from 'node:zlib';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'extension');
const outDir = join(root, 'dist');

/** Never ship these, whatever the OS leaves lying around. */
const EXCLUDE = /(^|\/)(\.|Thumbs\.db$|desktop\.ini$)/i;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed date and time, which is what the ZIP header carries. */
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Every file under `dir`, as ZIP-style forward-slash relative paths. */
async function collect(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (EXCLUDE.test(name)) continue;
    if (entry.isDirectory()) found.push(...(await collect(join(dir, entry.name), name)));
    else found.push(name);
  }
  return found;
}

function buildZip(entries) {
  const { time, day } = dosStamp(new Date());
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42); // where the local header starts
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

const names = (await collect(sourceDir)).sort();

// --- the checks worth making before an upload ---
const problems = [];
if (!names.includes('manifest.json')) problems.push('manifest.json is not at the root of extension/');
if (!names.includes('data/meta.json')) {
  problems.push('extension/data/ is missing — run `npm run build` first, it is gitignored');
}
for (const name of names) {
  if (name.includes('\\')) problems.push(`entry name contains a backslash: ${name}`);
}

const manifest = JSON.parse(await readFile(join(sourceDir, 'manifest.json'), 'utf8'));
for (const path of [...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})]) {
  if (!names.includes(path)) problems.push(`manifest references a missing file: ${path}`);
}
// The off-state icons are applied at runtime, so the manifest never mentions them.
for (const size of [16, 32]) {
  if (!names.includes(`icons/icon-off-${size}.png`)) problems.push(`missing runtime icon: icons/icon-off-${size}.png`);
}

if (problems.length) {
  console.error('Cannot package:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const entries = await Promise.all(names.map(async (name) => ({ name, data: await readFile(join(sourceDir, name)) })));
const zip = buildZip(entries);

await mkdir(outDir, { recursive: true });
const slug = (manifest.name.match(/[a-z0-9]+/gi) ?? ['extension']).join('-').toLowerCase();
const outFile = join(outDir, `${slug}-${manifest.version}.zip`);
await writeFile(outFile, zip);

const raw = entries.reduce((n, e) => n + e.data.length, 0);
console.log(`${manifest.name}  v${manifest.version}`);
console.log(`  ${entries.length} files, ${(raw / 1e6).toFixed(2)} MB -> ${(zip.length / 1e6).toFixed(2)} MB zipped`);
console.log(`  ${outFile}`);
