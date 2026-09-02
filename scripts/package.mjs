/**
 * Packs `dist/` into `release/bunnylol-<version>.zip` for the Chrome Web Store,
 * with zero dependencies: local file headers, a central directory and an EOCD
 * record written by hand, entries deflated with node:zlib.
 *
 * Three properties the store cares about, none of which a hand-made zip has
 * reliably:
 *
 * - `manifest.json` is at the zip ROOT. Entry names are relative to `dist/`,
 *   so zipping the folder itself — the classic rejected upload — cannot happen.
 * - No `*.map`, and no `//# sourceMappingURL=` comment pointing at one. The
 *   build ships sourcemaps unconditionally because they help both store review
 *   and local debugging; they are simply left out here rather than turned off
 *   behind a release flag, so there is one mechanism instead of two.
 * - Deterministic. Timestamps are fixed at the DOS epoch and entries are
 *   sorted, so the same `dist/` always produces a byte-identical archive and a
 *   diff in the zip means a diff in the build.
 *
 * Refuses to run when package.json and dist/manifest.json disagree on the
 * version: the version in the zip is the one the store enforces monotonically,
 * and a stale `dist/` would ship the wrong one under the right filename.
 *
 *   pnpm package
 *
 * Nothing tests this file: it writes a binary artefact no other code reads, and
 * a test that reimplemented the format would only agree with itself. Verify it
 * by hand after changing it, from the repo root:
 *
 *   pnpm package && shasum -a 256 release/*.zip
 *   pnpm package && shasum -a 256 release/*.zip   # same digest, or determinism broke
 *   unzip -l release/*.zip                        # manifest.json at the root, no *.map
 *   unzip -t release/*.zip                        # every CRC checks out
 *   unzip -p release/*.zip '*.js' | grep -c sourceMappingURL   # 0
 */

import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from './lib/crc32.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'dist');
const RELEASE = join(root, 'release');

/** 1980-01-01 00:00, the DOS epoch: ((y-1980) << 9) | (m << 5) | d. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** General-purpose bit 11: entry names are UTF-8, not CP437. Every name this
 *  writes is ASCII today, but the flag is what stops an accented filename from
 *  being decoded as mojibake by a reader that honours the default. */
const FLAG_UTF8 = 0x0800;

/** The plain-zip ceilings. Past either one the format needs the zip64 records
 *  this writer does not emit, and a silently truncated field is a corrupt
 *  archive rather than a visible failure. */
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

function die(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    die(`cannot read ${what} (${path}): ${err.message}`);
  }
}

/**
 * Vite ends every emitted chunk with `//# sourceMappingURL=<chunk>.js.map`, and
 * the maps are not in the archive — so without this every packed script makes
 * DevTools ask the extension for a file that is not there. Only the trailing
 * comment goes; the code above it is untouched, and the rewrite happens before
 * the CRC and the deflate, so the archive stays a pure function of `dist/`.
 */
function stripSourcemapComment(name, bytes) {
  if (!name.endsWith('.js')) return bytes;
  const text = bytes.toString('utf8');
  const stripped = text.replace(/\/\/# sourceMappingURL=[^\n]*\n?$/, '');
  return stripped === text ? bytes : Buffer.from(stripped, 'utf8');
}

/** Every file under `dir`, depth-first, as absolute paths. */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/* ------------------------------------------------------------------ zip */

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

/**
 * One entry, deflated unless that makes it bigger, in which case it is stored.
 * Only the icon PNGs land on the stored side: they are already deflate streams
 * and grow by the wrapper. The woff2 still shrinks, by a hair, so the choice is
 * made per entry from the measured result rather than guessed from the
 * extension.
 */
function compress(bytes) {
  const deflated = deflateRawSync(bytes, { level: 9 });
  return deflated.length < bytes.length
    ? { method: METHOD_DEFLATE, data: deflated }
    : { method: METHOD_STORE, data: bytes };
}

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  if (entries.length > MAX_ENTRIES) die('archive needs zip64');

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const { method, data } = compress(entry.bytes);
    const crc = crc32(entry.bytes);

    if (offset > MAX_SIZE || data.length > MAX_SIZE || entry.bytes.length > MAX_SIZE) {
      die('archive needs zip64');
    }

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed to extract: 2.0, which is deflate
      u16(FLAG_UTF8), // no encryption and no data descriptor: sizes are known up front
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(data.length),
      u32(entry.bytes.length),
      u16(name.length),
      u16(0), // no extra field: an extended timestamp would undo determinism
      name,
    ]);
    locals.push(local, data);

    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20), // version made by
        u16(20),
        u16(FLAG_UTF8), // must match the local record, or readers disagree on the name
        u16(method),
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(crc),
        u32(data.length),
        u32(entry.bytes.length),
        u16(name.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk number
        u16(0), // internal attributes
        u32(0), // external attributes: no unix mode, so no umask in the output
        u32(offset),
        name,
      ]),
    );

    offset += local.length + data.length;
  }

  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);
  if (body.length > MAX_SIZE || directory.length > MAX_SIZE) die('archive needs zip64');
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directory.length),
    u32(body.length),
    u16(0), // no archive comment
  ]);

  // No directory entries are emitted; Chrome creates the paths it needs.
  return Buffer.concat([body, directory, eocd]);
}

/* ----------------------------------------------------------------- main */

const pkg = readJson(join(root, 'package.json'), 'package.json');
const version = pkg.version;

if (!existsSync(DIST)) die('dist/ is missing — run pnpm build first');
const files = walk(DIST);

const manifest = readJson(join(DIST, 'manifest.json'), 'dist/manifest.json');
if (manifest.version !== version) {
  die(
    `version mismatch: package.json is ${version}, dist/manifest.json is ${manifest.version}. ` +
      'Bump both and rebuild.',
  );
}

const entries = files
  .map((path) => ({ name: relative(DIST, path).split(sep).join('/'), path }))
  .filter((entry) => !entry.name.endsWith('.map'))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  .map((entry) => ({
    name: entry.name,
    bytes: stripSourcemapComment(entry.name, readFileSync(entry.path)),
  }));

// `readJson` above follows symlinks and `walk()` does not — it takes only
// `isFile()` entries — so a symlinked dist/manifest.json passes the version
// check and then never reaches the archive. That is the one way to get this far
// without it, and an upload missing its manifest is rejected on the far side.
if (!entries.some((entry) => entry.name === 'manifest.json')) {
  die('dist/manifest.json did not survive the walk — refusing to write a zip without it');
}

const archive = zip(entries);
const out = join(RELEASE, `bunnylol-${version}.zip`);
mkdirSync(RELEASE, { recursive: true });
writeFileSync(out, archive);

const raw = entries.reduce((total, entry) => total + entry.bytes.length, 0);
console.log(
  `${relative(root, out)}: ${entries.length} files, ` +
    `${(raw / 1024).toFixed(1)} KB in, ${(archive.length / 1024).toFixed(1)} KB out`,
);
