/**
 * CRC-32 (IEEE 802.3, the reflected 0xedb88320 polynomial).
 *
 * Both formats this repo writes by hand need it and they need the same one: a
 * PNG chunk checksum (scripts/gen-icons.mjs) and a ZIP entry checksum
 * (scripts/package.mjs). Shared rather than copied so a fix cannot land in one
 * and not the other. Pure, with no node imports, so it stays trivially
 * testable and standalone.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The checksum of `buf` (any indexable byte sequence) as an unsigned 32-bit int. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
