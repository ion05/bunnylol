/**
 * Generates the extension icons with zero dependencies: the shapes are signed
 * distance fields sampled at 4x4 per pixel, and the PNGs are encoded by hand
 * (IHDR + IDAT + IEND, one zlib stream, filter byte 0 per scanline).
 *
 * Both colours are read out of design/tokens.css, the sand tile is --accent
 * and the glyph is --accent-fg, so the icon cannot drift from the palette.
 * Those two tokens are declared as flat hexes rather than light-dark() pairs
 * precisely because a PNG has one colour, not one per scheme.
 *
 * Writes public/icons/icon{16,32,48,128}.png, full-bleed for the toolbar and
 * the extensions page. The 128 is also what the README shows as the logo.
 *
 * Deterministic: re-running writes byte-identical files.
 *
 *   node scripts/gen-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from './lib/crc32.mjs';
import { readFlatHex } from './lib/tokens.mjs';

const SIZES = [16, 32, 48, 128];

/** Subsamples per axis. 4x4 = 16 coverage samples per pixel. */
const SS = 4;

/* -------------------------------------------------------------- palette */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(root, 'design', 'tokens.css');

const tokensCss = readFileSync(TOKENS, 'utf8');

const BG = readFlatHex(tokensCss, '--accent');
/* Dark glyph, not white: #1a1a1a on the sand is 8.53:1, where #ffffff would be
 * 2.04:1 and fail the 3:1 WCAG 1.4.11 asks of a graphical object. */
const FG = readFlatHex(tokensCss, '--accent-fg');

/* ------------------------------------------------------------------ PNG */

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- geometry */
/* All coordinates are in the unit square, so one description fits every size. */

function sdRoundedRect(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - halfW + r;
  const qy = Math.abs(y - cy) - halfH + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCapsule(x, y, ax, ay, bx, by, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) - r;
}

/** Shrinks the glyph about the centre so it never crowds the rounded corners. */
const GLYPH_SCALE = 0.86;

const EAR_R = 0.066;
const EAR_TIP_Y = 0.205;
const EAR_BASE_Y = 0.585;

/** Half the tile's width, in the unit square. The toolbar icons are full
 *  bleed; the Web Store asks for 96px of art inside a 128px frame. */
const TILE_HALF = 0.48;

function insideBackground(x, y, half) {
  return sdRoundedRect(x, y, 0.5, 0.5, half, half, 0.22 * (half / TILE_HALF)) <= 0;
}

function insideGlyph(x, y, half) {
  /* The glyph shrinks with the tile, so the padded variant is the same drawing
   * rather than the same rabbit in a smaller box. */
  const scale = GLYPH_SCALE * (half / TILE_HALF);
  const gx = 0.5 + (x - 0.5) / scale;
  const gy = 0.5 + (y - 0.5) / scale;

  // Head, then the two ears splayed outward from it.
  if (sdRoundedRect(gx, gy, 0.5, 0.705, 0.205, 0.155, 0.145) <= 0) return true;
  if (sdCapsule(gx, gy, 0.437, EAR_BASE_Y, 0.352, EAR_TIP_Y, EAR_R) <= 0) return true;
  if (sdCapsule(gx, gy, 0.563, EAR_BASE_Y, 0.648, EAR_TIP_Y, EAR_R) <= 0) return true;
  return false;
}

function render(size, half) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);
  const samples = SS * SS;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0;
      let glyph = 0;

      for (let sy = 0; sy < SS; sy++) {
        const y = (py * SS + sy + 0.5) * step;
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          if (!insideBackground(x, y, half)) continue;
          covered++;
          if (insideGlyph(x, y, half)) glyph++;
        }
      }

      const i = (py * size + px) * 4;
      if (covered === 0) continue;

      // Average the opaque samples, then store straight (un-premultiplied) alpha.
      const mix = glyph / covered;
      rgba[i] = Math.round(BG[0] + (FG[0] - BG[0]) * mix);
      rgba[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * mix);
      rgba[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * mix);
      rgba[i + 3] = Math.round((covered / samples) * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/* ----------------------------------------------------------------- main */

const hex = (rgb) => rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
console.log(`tile #${hex(BG)}, glyph #${hex(FG)}  (design/tokens.css)`);

const emit = (file, size, half) => {
  mkdirSync(dirname(file), { recursive: true });
  const png = render(size, half);
  writeFileSync(file, png);
  console.log(`${relative(root, file)}  ${png.length} bytes  (${size}x${size})`);
};

for (const size of SIZES) {
  emit(join(root, 'public', 'icons', `icon${size}.png`), size, TILE_HALF);
}
