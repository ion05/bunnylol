/**
 * Reading design/tokens.css from a build script.
 *
 * Split out of gen-icons.mjs so the parse can be exercised directly: the icon
 * generator only ever runs against the real token file, where the two failure
 * modes this guards — a renamed token and one that became a light-dark() pair —
 * cannot be reproduced without editing the palette. Pure by construction, with
 * no node imports, so a test can import it too.
 */

/**
 * One flat `--name: #rrggbb;` declaration out of `css`, as [r, g, b].
 *
 * The colon has to follow the name immediately, so --accent-hover and
 * --accent-text cannot answer for --accent, and comments are stripped first
 * because tokens.css discusses its own values in prose. Throwing on a miss is
 * the point: a renamed token, or one that became a light-dark() pair, has no
 * single colour an icon could use, and failing `pnpm build` loudly is better
 * than shipping the wrong one.
 */
export function readFlatHex(css, name) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const match = new RegExp(`${name}:\\s*#([0-9a-fA-F]{6})\\s*;`).exec(bare);
  if (!match) throw new Error(`${name} is not a flat #rrggbb in design/tokens.css`);
  return [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16));
}
