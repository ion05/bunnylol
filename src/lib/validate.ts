/**
 * The single boundary that decides whether an alias or a destination is usable.
 *
 * Both questions used to be answered by "is the string non-empty", in two
 * different modules, and both answers were wrong: an alias containing a space
 * can never match — `resolve()` splits the query at the first whitespace — and
 * `defaultEngine: "not a url"` turned every fallback search into a navigation
 * to a missing extension resource, because `toNavigableUrl` treats anything
 * without a scheme as an extension-relative path.
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
