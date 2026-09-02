/**
 * The single boundary that decides whether an alias, a destination or a section
 * identity is usable.
 *
 * The first two used to be answered by "is the string non-empty", in two
 * different modules, and both answers were wrong: an alias containing a space
 * can never match — `resolve()` splits the query at the first whitespace — and
 * `defaultEngine: "not a url"` turned every fallback search into a navigation
 * to a missing extension resource, because `toNavigableUrl` treats anything
 * without a scheme as an extension-relative path.
 *
 * The section id and label questions live here for the same reason, before
 * there is a section editor to put them next to.
 *
 * Pure, and imports only the escape prefixes from the contract: it is used by
 * the resolver, by storage's lenient recovery path and by the strict import
 * parser, which must all agree on what "valid" means.
 */

import { FORCE_SEARCH_PREFIXES } from './types';

/**
 * Aliases handed to the DNR regex alternation: ASCII only, and no character
 * that is a regex metacharacter (`.`, `+`, `?`, `*`, `|`, `(`, …) or that the
 * browser would percent-encode inside a search query.
 *
 * NOT the same question as `validateAlias`. An alias outside this set is still
 * a working shortcut from the `bl` omnibox and the popup; it just cannot be
 * address-bar intercepted, so `activeKeywords` filters on this while storage
 * keeps the alias.
 */
export const SAFE_KEYWORD = /^[a-z0-9_][a-z0-9_-]*$/;

/** Nobody types a 33-character keyword; longer entries are imported junk. */
export const MAX_KEYWORD_LENGTH = 32;

/** Stands in for `{q}` / `%s` while the template is parsed. Never navigated to. */
const PLACEHOLDER_PROBE = 'bunnylolplaceholder';

const PLACEHOLDER = /\{q\}|%s/g;

export type AliasCheck = { ok: true; alias: string } | { ok: false; reason: string };

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * A keyword the resolver can actually match: exactly one non-whitespace token.
 *
 * The token contract is the whole point. `resolve()` takes the text up to the
 * first whitespace as the keyword, so `"foo bar"` is not a slow shortcut or a
 * quirky one — it is unreachable on every surface, and storing it just hides a
 * dead entry in the user's list.
 */
export function validateAlias(raw: string): AliasCheck {
  const alias = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!alias) return { ok: false, reason: 'is empty' };
  if (/\s/.test(alias)) {
    return {
      ok: false,
      reason: `contains a space ("${alias}") — a keyword is the first word of a query, so it cannot contain one`,
    };
  }
  if (alias.length > MAX_KEYWORD_LENGTH) {
    return { ok: false, reason: `is longer than ${MAX_KEYWORD_LENGTH} characters ("${alias}")` };
  }
  // Same dead-keyword trap as whitespace, one step earlier in the resolver:
  // `resolve()` strips a leading escape prefix and plain-searches the rest, so
  // it never gets as far as looking `=foo` up in the key map.
  const escape = FORCE_SEARCH_PREFIXES.find((prefix) => alias.startsWith(prefix));
  if (escape !== undefined) {
    return {
      ok: false,
      reason: `starts with "${escape}" ("${alias}") — a leading ${FORCE_SEARCH_PREFIXES.map((p) => `"${p}"`).join(' or ')} forces a plain search, so a keyword cannot begin with one`,
    };
  }
  return { ok: true, alias };
}

/** True when this alias can also be address-bar intercepted by a DNR rule. */
export function isInterceptableAlias(alias: string): boolean {
  return alias.length <= MAX_KEYWORD_LENGTH && SAFE_KEYWORD.test(alias);
}

/**
 * A destination BunnyLol will navigate to: `http`/`https` with a real host,
 * with `{q}` and `%s` tolerated anywhere in it.
 *
 * Parsing beats blocklisting a handful of schemes. A blocklist let `mailto:`
 * and `ftp:` through, which no surface here can open, and let plain prose
 * through, which is worse than either: an unparseable `defaultEngine` breaks
 * every unmatched query rather than one shortcut.
 *
 * Returns the ORIGINAL string (trimmed), placeholders intact — the probe token
 * exists only to get a template past the URL parser.
 */
export function validateUrlTemplate(raw: string): UrlCheck {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) return { ok: false, reason: 'is empty' };

  let parsed: URL;
  try {
    parsed = new URL(url.replace(PLACEHOLDER, PLACEHOLDER_PROBE));
  } catch {
    return { ok: false, reason: `is not a URL ("${url}")` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `is not an http(s) URL ("${url}")` };
  }
  if (!parsed.hostname) return { ok: false, reason: `has no host ("${url}")` };

  return { ok: true, url };
}

/**
 * A section id is a slug, not an alias: it is never typed into the address bar,
 * so the interceptability rules do not apply — but it IS the `category` value
 * stored on every member command, and it round-trips through the export file,
 * so it has to be a single canonical token.
 */
export const SAFE_SECTION_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Same "imported junk" ceiling as a keyword; ids are machine-facing. */
export const MAX_SECTION_ID_LENGTH = 32;

/** A label is display text, so it may be longer — but not layout-breaking. */
export const MAX_SECTION_LABEL_LENGTH = 40;

/**
 * Line breaks and other unprintables: invisible in the UI, corrupting in the
 * file. `\p{Cc}` alone is not that set — U+2028/U+2029 are Zl/Zp and CSS treats
 * both as forced line breaks (a two-line section heading), and the zero-width
 * spaces and the bidi overrides are Cf, which `trim()` never strips. (The BOM is
 * Cf too but IS trimmed at the edges, so only an interior one needs this class.)
 *
 * The two joiners are exempt: U+200D joins emoji sequences (`👨‍💻 Dev`) and
 * U+200C is required orthography in Persian, Urdu and several Indic scripts.
 * The rest of Cf stays out — a soft hyphen or a bidi override in a heading is
 * not text someone typed on purpose.
 */
const UNPRINTABLE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * One character the user can actually see. A label made only of invisibles is a
 * section that cannot be found, told apart from the next blank one or renamed,
 * and the invisibles are not all Cf: U+2800 BRAILLE PATTERN BLANK is So, the
 * Hangul fillers are Lo, and a lone combining mark has nothing to combine with.
 * Asking for a visible character catches all of them, including the joiners
 * `UNPRINTABLE` deliberately lets through, without enumerating the rest.
 */
const VISIBLE = /[^\s\u200B-\u200F\u2060\uFEFF\u115F\u1160\u2800\u3164\uFFA0\p{M}]/u;

export type SectionIdCheck = { ok: true; id: string } | { ok: false; reason: string };

export type SectionLabelCheck = { ok: true; label: string } | { ok: false; reason: string };

/**
 * A section id that storage, the export file and the options UI all agree on.
 *
 * Deliberately PERMISSIVE about ids that name a builtin category: an entry
 * whose id is `dev` is not a collision, it is how a shipped category gets
 * renamed. Shape is the only question asked.
 *
 * It lives here rather than beside the section editor for the reason in this
 * module's header — one boundary. A section id with a space or a stray `.` is
 * the same silent death an alias with a space was: it persists happily and then
 * never matches the category it is supposed to name.
 */
export function validateSectionId(raw: string): SectionIdCheck {
  const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!id) return { ok: false, reason: 'is empty' };
  if (/\s/.test(id)) return { ok: false, reason: `contains a space ("${id}")` };
  if (id.length > MAX_SECTION_ID_LENGTH) {
    return { ok: false, reason: `is longer than ${MAX_SECTION_ID_LENGTH} characters ("${id}")` };
  }
  if (!SAFE_SECTION_ID.test(id)) {
    return {
      ok: false,
      reason: `is not a slug ("${id}") — use letters, numbers and "-", starting with a letter or number`,
    };
  }
  return { ok: true, id };
}

/**
 * The human-facing name of a section. Trimmed, never lowercased — unlike an id
 * this one is displayed, so `Work stuff` and `Wörk stuff` are both fine.
 *
 * Nothing here escapes anything: user text reaches the DOM through
 * `textContent` (invariant 11), so this is about a label that would break the
 * layout or the export file, not about rendering safety.
 */
export function validateSectionLabel(raw: string): SectionLabelCheck {
  const label = typeof raw === 'string' ? raw.trim() : '';
  // The second half is not redundant with `trim()`: a label of joiners, braille
  // blanks or combining marks is "non-empty" and every one of them renders as a
  // heading the user cannot see.
  if (!label || !VISIBLE.test(label)) return { ok: false, reason: 'is empty' };
  // Code points, not `.length`: an astral character costs two UTF-16 units and
  // an emoji ZWJ sequence five, so counting units would reject `👨‍💻 Dev` — the
  // exact label this validator goes out of its way to accept — with a reason
  // string quoting a number the user cannot reconcile with what they typed.
  if ([...label].length > MAX_SECTION_LABEL_LENGTH) {
    return {
      ok: false,
      reason: `is longer than ${MAX_SECTION_LABEL_LENGTH} characters ("${label}")`,
    };
  }
  if (UNPRINTABLE.test(label)) {
    return { ok: false, reason: 'contains a line break or an invisible character' };
  }
  return { ok: true, label };
}
