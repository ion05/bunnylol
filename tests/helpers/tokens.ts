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

/**
 * Every rule as a selector list plus its body. `[^{}]` never crosses a brace, so
 * a capture is exactly the text between the previous rule's `}` and this rule's
 * `{`, which is the selector, whether or not it sits inside an `@media` block.
 */
export function rules(css: string): { selector: string; body: string }[] {
  return [...stripComments(css).matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, ' '),
    body: m[2],
  }));
}

/**
 * The source-order position of the first rule whose selector list contains
 * `selector`, or -1 when the sheet has none.
 *
 * Order is load-bearing wherever two rules are equally specific: `.btn:disabled`
 * only beats `.btn-ghost:hover` because it is declared after it, and nothing
 * about either rule's text records that. A test that pins a cascade has to be
 * able to ask where a rule sits, not just what it says.
 */
export function ruleIndex(css: string, selector: string): number {
  return rules(css).findIndex((rule) =>
    rule.selector.split(',').some((one) => one.trim() === selector),
  );
}

/**
 * The bodies of every rule whose selector list contains `selector`, in source
 * order. An `@media` override is a second entry rather than a different rule,
 * so a caller that expects one has to say so.
 */
export function rulesFor(css: string, selector: string): string[] {
  return rules(css)
    .filter((rule) => rule.selector.split(',').some((one) => one.trim() === selector))
    .map((rule) => rule.body);
}
