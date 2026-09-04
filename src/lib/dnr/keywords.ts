/**
 * Which aliases are eligible for interception, which of them survive the caps,
 * and in what order they are written into a rule's alternation.
 *
 * Pure: no `chrome.*`, no DOM, so the ranking and the sharding are unit
 * testable in Node.
 *
 * Both callers of `./rules` sit on top of this one list. `buildRules` and the
 * production `syncRules` path shard an identical keyword list through
 * `rankKeywords` and `shardKeywords`, so a change to what survives cannot
 * reach one of them and not the other.
 */

import { BUILTIN_COMMANDS } from '../commands';

// ----------------------------------------------------------------- budgets ----

/**
 * Chrome compiles each `regexFilter` with `RE2::Options::set_max_mem(2 * 1024)`,
 * and a pattern that busts that budget is simply reported unsupported: the rule
 * is dropped and nothing is ever intercepted, which looks exactly like a broken
 * extension.
 *
 * The budget is on the COMPILED PROGRAM, and a long alternation of short
 * literals compiles to far more than its source length suggests, so no
 * source-character cap can be proven safe here. This one is only a first guess
 * that keeps shards small; `syncRules` asks `isRegexSupported` about every rule
 * and halves the ones Chrome rejects.
 */
export const MAX_ALTERNATION_CHARS = 120;

/**
 * Keywords past this many shards are not intercepted; see `shardKeywords`.
 *
 * With an empty stop list the whole builtin registry is eligible (~317 aliases,
 * 18 shards per engine), so the old cap of 32 left room for barely 200 custom
 * aliases before the address bar started silently dropping them. Sized now so
 * ~1600 aliases fit, which is every builtin plus a very large imported profile,
 * and matched to `MAX_RULES` so neither cap binds noticeably before the other.
 */
const MAX_SHARDS_PER_ENGINE = 96;

// ---------------------------------------------------------- regex escaping ----

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

export function escapeRegex(value: string): string {
  return value.replace(REGEX_META, '\\$&');
}

// ----------------------------------------------------------------- ranking ----

/**
 * Every alias this build ships, lowercased. Only used to RANK keywords for
 * retention: a user with 400 imported shortcuts must not lose `gh` to them.
 */
const BUILTIN_ALIASES = new Set<string>(
  BUILTIN_COMMANDS.flatMap((cmd) => cmd.keys ?? []).map((key) => key.trim().toLowerCase()),
);

/** Lowercased (the rules match case-insensitively) and deduped, order untouched. */
export function dedupeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  for (const keyword of keywords ?? []) {
    const alias = (keyword ?? '').trim().toLowerCase();
    if (alias) seen.add(alias);
  }
  return [...seen];
}

/**
 * TWO ORDERS, ONE LIST: the subtle part of this file.
 *
 * `rankKeywords` decides WHICH keywords survive: the shard cap and the rule
 * budget both truncate the tail of this order, so it must put the keywords a
 * user would miss most at the front: builtins before custom shortcuts, and
 * shorter (hotter, and cheaper in the alternation) before longer.
 *
 * `alternationOrder` decides how the survivors are WRITTEN into one rule's
 * regex: longest-first, so the alternation offers `github` before `gh`.
 *
 * Ranking longest-first, as this used to, made the two the same order and cut
 * from the wrong end: `gh`, `g` and `npm` were the first aliases dropped once
 * a few hundred custom commands pushed past the budget.
 */
export function rankKeywords(keywords: string[]): string[] {
  return dedupeKeywords(keywords).sort((a, b) => {
    const builtin = Number(BUILTIN_ALIASES.has(b)) - Number(BUILTIN_ALIASES.has(a));
    if (builtin !== 0) return builtin;
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  });
}

function alternationOrder(keywords: string[]): string[] {
  return [...keywords].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------- sharding ----

/**
 * Splits the alternation across rules to stay under the per-rule regex budget.
 * Every shard captures the same thing for a given url, so it does not matter
 * which shard Chrome picks when two of them match.
 *
 * Keywords beyond `MAX_SHARDS_PER_ENGINE` shards are dropped: they still work
 * from the omnibox and the popup, they just are not intercepted from the search
 * engine. Silently dropping beats failing the whole sync.
 */
export function shardKeywords(keywords: string[]): string[][] {
  const shards: string[][] = [];
  let current: string[] = [];
  let width = 0;

  for (const keyword of keywords) {
    const cost = escapeRegex(keyword).length + 1; // +1 for the `|` separator
    if (current.length > 0 && width + cost > MAX_ALTERNATION_CHARS) {
      shards.push(current);
      current = [];
      width = 0;
    }
    current.push(keyword);
    width += cost;
  }
  if (current.length > 0) shards.push(current);

  // Packed in rank order so the cap drops the least-wanted keywords, then each
  // surviving shard is rewritten longest-first for its own alternation.
  return shards.slice(0, MAX_SHARDS_PER_ENGINE).map(alternationOrder);
}
