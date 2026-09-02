/**
 * The brain: query string in, destination URL out.
 *
 * Pure and synchronous — no `chrome.*`, no DOM, no I/O — so the dispatch page,
 * the omnibox, the popup, the options live preview and the unit tests all run
 * the exact same code path.
 */

import type { Command, HandlerFn, Overrides, ResolveResult, Settings } from './types';
import { DEFAULT_SETTINGS, FORCE_SEARCH_PREFIXES, PASSTHROUGH_PARAM } from './types';
// `commands.ts` imports nothing but `types.ts`, so this stays acyclic and the
// engine hosts have exactly one definition.
import { SEARCH_ENGINES } from './commands';
import { expandTemplate, HANDLERS } from './handlers';
// Identity and the edit algebra live in one module so the resolver, storage and
// the options page cannot disagree about which shortcut an override entry names
// or about what it is allowed to change.
import { applyEdit, knownCategoryIds, normalizeId, shortcutId } from './overrides';
// Which aliases a DNR rule can carry is decided in one place; `activeKeywords`
// and the storage boundary must not drift apart on it.
import { isInterceptableAlias } from './validate';

// Defined next to the encoder it uses, because the handlers need it too.
export { expandTemplate } from './handlers';

/** Matches `?blpass=1` / `&blpass=1`, plus a following `&` when there is one. */
const PASSTHROUGH_MARKER = new RegExp(`([?&])${PASSTHROUGH_PARAM}=[^&#]*(&)?`, 'gi');

const PASSTHROUGH_PRESENT = new RegExp(`[?&]${PASSTHROUGH_PARAM}=`, 'i');

const SCORE_EXACT_ALIAS = 100;
const SCORE_ALIAS_PREFIX = 80;
const SCORE_NAME_PREFIX = 60;
const SCORE_WORD_CONTAINS = 40;
const SCORE_SUBSEQUENCE = 20;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Hosts whose result pages the DNR rules rewrite, with `www.` stripped so
 * `google.com` and `www.google.com` count as the same engine.
 */
const INTERCEPTED_HOSTS = new Set(SEARCH_ENGINES.map((engine) => bareHost(engine.host)));

/**
 * Alias -> command, every alias lowercased.
 *
 * ORDERING CONTRACT: the FIRST command to claim an alias keeps it. This is only
 * correct because `mergeCommands` puts custom commands ahead of builtins — a
 * user who rebinds `gh` shadows the builtin. If the last writer won instead,
 * their custom command would be silently swallowed by the builtin behind it.
 */
export function buildKeyMap(commands: Command[]): Map<string, Command> {
  const map = new Map<string, Command>();
  for (const cmd of commands) {
    for (const key of cmd.keys ?? []) {
      const alias = key.trim().toLowerCase();
      if (!alias || map.has(alias)) continue;
      map.set(alias, cmd);
    }
  }
  return map;
}

/**
 * Applies the user's customization layer on top of the builtin registry without
 * mutating either. Custom commands come first so they win alias collisions in
 * `buildKeyMap`.
 */
export function mergeCommands(builtins: Command[], overrides: Overrides): Command[] {
  // Read through `normalizeId`, the one reader of an id off untrusted storage:
  // a second normalisation here is how a blob's `GH ` stops matching the `gh`
  // the rest of the extension resolved it to.
  const disabled = new Set((overrides?.disabled ?? []).map(normalizeId).filter(Boolean));
  const deleted = new Set((overrides?.deleted ?? []).map(normalizeId).filter(Boolean));
  const edits = overrides?.edits ?? {};
  // An edit may file a shipped command under a user section, so the sections
  // this profile declares are part of what an edit is allowed to say.
  const known = knownCategoryIds(overrides?.sections);
  const merged: Command[] = [];

  // Custom first: `buildKeyMap` is first-writer-wins, so a user's own `gh`
  // shadows the builtin rather than being ignored (invariant 10).
  for (const cmd of overrides?.custom ?? []) {
    // Every emitted command carries its resolved id: the browse rows, the
    // override maps and the resolver then key off one string, and no surface
    // has to know whether the command came from the registry or from storage.
    const id = shortcutId(cmd);
    if (disabled.has(id)) continue;
    merged.push({ ...cmd, id, keys: [...(cmd.keys ?? [])] });
  }

  for (const cmd of builtins) {
    const id = shortcutId(cmd);
    if (deleted.has(id) || disabled.has(id)) continue;
    // AFTER the id and the keys copy: an edit's `keys` replaces the shipped
    // ones, and it must land on the copy rather than on the registry entry.
    merged.push(applyEdit({ ...cmd, id, keys: [...(cmd.keys ?? [])] }, edits[id], known));
  }
  return merged;
}

/**
 * Resolves a raw address-bar query. Never throws: every failure path degrades to
 * a real URL, because the caller has already committed to navigating somewhere.
 *
 * - A leading `FORCE_SEARCH_PREFIXES` character — `\<query>` or `=<query>`, with
 *   or without a following space — forces a plain default-engine search of the
 *   remainder. Under true bunnylol semantics a registered first word is ALWAYS a
 *   command, so this is the only way to search for one, and the prefix itself
 *   must never survive into the search terms.
 * - An empty or whitespace-only query returns the default engine's origin (e.g.
 *   `https://www.google.com/`) rather than a search page for the empty string.
 * - The keyword is the first whitespace-delimited token, matched case-
 *   insensitively; the arguments keep their original case and internal spacing.
 */
export function resolve(query: string, commands: Command[], settings: Settings): ResolveResult {
  const engine = settings?.defaultEngine || DEFAULT_SETTINGS.defaultEngine;
  const trimmed = (query ?? '').trim();

  const escape = FORCE_SEARCH_PREFIXES.find((prefix) => trimmed.startsWith(prefix));
  if (escape !== undefined) {
    return searchFallback(trimmed.slice(escape.length).trim(), engine);
  }
  if (!trimmed) return searchFallback('', engine);

  const boundary = trimmed.search(/\s/);
  const keyword = boundary < 0 ? trimmed : trimmed.slice(0, boundary);
  const args = boundary < 0 ? '' : trimmed.slice(boundary + 1).trim();

  const cmd = buildKeyMap(commands).get(keyword.toLowerCase());
  if (!cmd) return searchFallback(trimmed, engine);

  return { url: destination(cmd, args, settings, keyword), command: cmd, args, fallback: false };
}

/**
 * Ranks commands for the omnibox and the popup's autocomplete. An empty query
 * returns the first `limit` commands in registry order, which is already
 * curated. Ties are broken by canonical key so the list never jitters.
 */
export function suggest(query: string, commands: Command[], limit = 8): Command[] {
  if (limit <= 0) return [];
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, limit);

  let ranked = rank(q, commands);
  if (ranked.length === 0 && /\s/.test(q)) {
    // "gh facebo": once the keyword is followed by arguments, the keyword alone
    // is what we can still usefully rank against.
    ranked = rank(q.slice(0, q.search(/\s/)), commands);
  }
  return ranked.slice(0, limit).map((entry) => entry.cmd);
}

/**
 * Every alias that can appear in the DNR regex, deduped and sorted longest-first
 * so an alternation prefers `github` over `gh` when both would match.
 *
 * `stopList` is the user's EXEMPTION list and suppresses aliases from
 * ADDRESS-BAR INTERCEPTION ONLY. It is empty by default — every registered
 * keyword is intercepted — and `resolve()` deliberately ignores it, so an
 * exempted alias keeps working through the `bl` omnibox and the popup, where
 * the user has already said they mean a shortcut.
 */
export function activeKeywords(commands: Command[], stopList?: string[]): string[] {
  const stopped = new Set<string>();
  for (const entry of stopList ?? []) {
    const alias = (entry ?? '').trim().toLowerCase();
    if (alias) stopped.add(alias);
  }

  const seen = new Set<string>();
  for (const cmd of commands) {
    for (const key of cmd.keys ?? []) {
      const alias = key.trim().toLowerCase();
      if (!alias || !isInterceptableAlias(alias)) continue;
      if (stopped.has(alias)) continue;
      seen.add(alias);
    }
  }
  return [...seen].sort((a, b) => b.length - a.length || compareKeys(a, b));
}

/**
 * Marks a URL as BunnyLol's own fallback search so the DNR allow rule in
 * `dnr.ts` lets it through untouched. Without it, `\gh foo` resolves to a
 * Google search for "gh foo", which our own redirect rule matches (`%20` is an
 * accepted separator) and bounces straight back into the command the user was
 * escaping. Idempotent, and it keeps any fragment last.
 */
export function withPassthrough(url: string): string {
  const target = url ?? '';
  if (!target || hasPassthrough(target)) return target;
  const hash = target.indexOf('#');
  const base = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? '' : target.slice(hash);
  return `${base}${base.includes('?') ? '&' : '?'}${PASSTHROUGH_PARAM}=1${fragment}`;
}

/** True when `url` is already marked as a BunnyLol-generated search. */
export function hasPassthrough(url: string): boolean {
  return PASSTHROUGH_PRESENT.test(url ?? '');
}

/**
 * Removes the passthrough marker. Works on a whole URL (for display) and on a
 * raw `q` value captured out of a search URL, which is why go.ts should run it
 * over the query it was handed before resolving: a stale rule from an older
 * build can glue `&blpass=1` onto the end of the query itself.
 */
export function stripPassthrough(query: string): string {
  return (query ?? '')
    .replace(PASSTHROUGH_MARKER, (_match, lead: string, tail?: string) => (tail ? lead : ''))
    .trim();
}

/**
 * True only for a whole url carrying our marker — the one shape whose marker is
 * ours to remove. Arbitrary query text is never a candidate: a user who types
 * `gh foo&blpass=1` means those words, and stripping the marker out of them
 * would silently search for `gh foo` instead.
 */
export function isBouncedUrl(value: string): boolean {
  if (!hasPassthrough(value ?? '')) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A command destination can itself be a search on an engine we intercept:
 * `weather` IS a google search, and so are `g`, `gimg`, `gem` and the `gsite`
 * handler. Navigating there unmarked re-enters our own redirect rule, which
 * hands the url back to go.html — `weather` loops forever, `g npm install`
 * lands on the npm package page. Marking every destination in one place covers
 * `cmd.url`, `searchUrl` expansion and every handler return value alike.
 */
function destination(cmd: Command, args: string, settings: Settings, keyword: string): string {
  return guardOwnOutput(rawDestination(cmd, args, settings, keyword));
}

function rawDestination(cmd: Command, args: string, settings: Settings, keyword: string): string {
  // Typed as possibly undefined on purpose: an imported command can name a
  // handler this build doesn't have.
  const handler: HandlerFn | undefined = cmd.handler ? HANDLERS[cmd.handler] : undefined;
  if (handler) {
    try {
      // The typed alias, not `cmd.keys[0]`: a handler that degrades to a plain
      // search has to reproduce the query the alias intercepted.
      const url = handler(args, cmd, settings, keyword);
      if (url) return url;
    } catch {
      // A handler bug must not strand the user on an error page.
    }
    return cmd.url;
  }
  if (args && cmd.searchUrl) return expandTemplate(cmd.searchUrl, args);
  // Arguments with no `searchUrl` are meaningless for this command, so drop them
  // rather than inventing a `?q=` the destination doesn't understand.
  return cmd.url;
}

function guardOwnOutput(url: string): string {
  return isInterceptable(url) ? withPassthrough(url) : url;
}

/**
 * True when a redirect rule could claim `url`: it lives on an intercepted
 * engine AND carries a `q` value, which is what every `urlPrefixPattern`
 * anchors on. Host-based rather than prefix-based, so a `?q=` on some other
 * path of the same engine is covered too, while `https://www.google.com/maps`
 * is left clean.
 */
function isInterceptable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Relative or malformed: `toNavigableUrl` deals with it, and nothing our
    // rules match can get here.
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (!INTERCEPTED_HOSTS.has(bareHost(parsed.hostname.toLowerCase()))) return false;
  for (const name of parsed.searchParams.keys()) {
    if (name.toLowerCase() === 'q') return true;
  }
  return false;
}

function bareHost(host: string): string {
  return host.replace(/^www\./, '');
}

function searchFallback(args: string, engine: string): ResolveResult {
  return {
    // The marker only matters on a real search URL; the engine's bare home page
    // carries no `q` and so is never matched by a redirect rule anyway.
    url: args ? withPassthrough(expandTemplate(engine, args)) : engineHome(engine),
    command: null,
    args,
    fallback: true,
  };
}

function engineHome(engine: string): string {
  try {
    const { origin } = new URL(engine);
    if (origin.startsWith('http')) return `${origin}/`;
  } catch {
    // Not a parseable absolute URL — fall through to the template itself.
  }
  return expandTemplate(engine, '');
}

interface Scored {
  cmd: Command;
  score: number;
  key: string;
}

function rank(q: string, commands: Command[]): Scored[] {
  const scored: Scored[] = [];
  for (const cmd of commands) {
    const score = scoreCommand(q, cmd);
    if (score > 0) scored.push({ cmd, score, key: canonicalKey(cmd) });
  }
  scored.sort((a, b) => b.score - a.score || compareKeys(a.key, b.key));
  return scored;
}

function scoreCommand(q: string, cmd: Command): number {
  const aliases = (cmd.keys ?? []).map((key) => key.toLowerCase());
  if (aliases.includes(q)) return SCORE_EXACT_ALIAS;
  if (aliases.some((alias) => alias.startsWith(q))) return SCORE_ALIAS_PREFIX;

  const name = (cmd.name ?? '').toLowerCase();
  if (name.startsWith(q)) return SCORE_NAME_PREFIX;

  const description = (cmd.description ?? '').toLowerCase();
  if (startsAWord(name, q) || startsAWord(description, q)) return SCORE_WORD_CONTAINS;

  if (aliases.some((alias) => isSubsequence(q, alias))) return SCORE_SUBSEQUENCE;
  return 0;
}

/** True when `needle` occurs in `haystack` at the start of a word. */
function startsAWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  for (let from = 0; from <= haystack.length - needle.length; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (at === 0 || !WORD_CHAR.test(haystack[at - 1])) return true;
    from = at + 1;
  }
  return false;
}

/** Fuzzy match: every character of `needle`, in order, somewhere in `haystack`. */
function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle || needle.length > haystack.length) return false;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * The alias `suggest()` breaks ties on — deliberately NOT `shortcutId`. A tie
 * is settled alphabetically on what the user types; keying it off the id would
 * clump every custom shortcut together under its `u:` prefix instead of
 * ordering them by the alias the user actually typed.
 */
function canonicalKey(cmd: Command): string {
  return (cmd.keys?.[0] ?? '').trim().toLowerCase();
}

/** Locale-independent so ordering is identical in every browser and in Node. */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
