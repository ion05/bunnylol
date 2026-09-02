/**
 * Helpers for reading `design/tokens.css` as text. Later suites reuse
 * `tokenValue` to drive assertions off the token file rather than off a
 * hand-copied hex, so editing a token is what makes those tests fail.
 */

/** CSS with comments removed, so a prose mention of a token is never parsed as one. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The value of one custom property, resolved for a scheme.
 *
 * Tokens are declared exactly once with `light-dark(light, dark)` rather than
 * in a `prefers-color-scheme` block, so a scheme is a side of the pair. The two
 * deliberately flat tokens (`--accent`, `--accent-fg`) are the same value in
 * both and are returned as-is.
 *
 * Comments are stripped first: tokens.css discusses its own values in prose, and
 * a commented-out declaration above the live one would otherwise win the match.
 */
export function tokenValue(css: string, name: string, scheme: 'light' | 'dark'): string {
  const decl = new RegExp(`--${name}:\\s*([^;]+);`).exec(stripComments(css))?.[1].trim();
  if (!decl) throw new Error(`no --${name} in tokens.css`);
  const pair = /^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(decl);
  return pair ? (scheme === 'light' ? pair[1] : pair[2]) : decl;
}

/** Every `selector { ... }` rule body in a sheet, comments already stripped. */
export function ruleBodies(css: string): string[] {
  return [...stripComments(css).matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
}
