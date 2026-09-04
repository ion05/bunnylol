/**
 * Every declarativeNetRequest rule this extension can register, built without
 * touching `chrome.*`.
 *
 * ONE CONSTRUCTION PATH, TWO ENTRY POINTS. `planRedirects`, `redirectRule`,
 * `buildAllowRules` and `buildEscapeRules` are the only functions in the
 * codebase that mint a rule. `buildRules` composes them synchronously and is
 * called only by tests. Production reaches the same four through `syncRules`
 * in `../dnr.ts`, which takes the plan from `planRedirects` and hands it to
 * `fitPlan` in `./fit`, so Chrome can validate and resplit the very patterns
 * `buildRules` returns.
 *
 * That is also the limit of what a `buildRules` test proves: it exercises this
 * file with the fitting step removed, so it is not testing what ships. Adding
 * a rule shape here means both entry points inherit it; assembling a rule
 * family in either caller instead is how the two would drift.
 */

import { escapeRegex, rankKeywords, shardKeywords } from './keywords';
import { FORCE_SEARCH_PREFIXES, PASSTHROUGH_PARAM } from '../types';
import type { SearchEngine } from '../types';

// --------------------------------------------- priorities, ids and budgets ----

/**
 * Three tiers, and the order between them is the whole escape hatch.
 *
 * `allow` outranks everything: it is what stops a BunnyLol-generated fallback
 * search (anything go.ts sends to the default engine) from being caught by our
 * own redirect and bounced back into the command the user was escaping.
 *
 * `escape` sits between the two so a query beginning with a
 * `FORCE_SEARCH_PREFIXES` character can never be claimed by a keyword rule
 * first. In practice no keyword alternation can match one, the value starts
 * with `\`, `=` or a `%` escape, and no alias may contain those, but the
 * escape hatch is load-bearing enough that it should not depend on a property
 * of the alias charset that a later change could quietly relax.
 */
const REDIRECT_PRIORITY = 1;
const ESCAPE_PRIORITY = 2;
const ALLOW_PRIORITY = 3;

/**
 * Rule ids are `shard * STRIDE + engineIndex + 1`, so the common single-shard
 * case yields 1, 2, 3, one per engine, and shards never collide.
 */
const RULE_ID_SHARD_STRIDE = 100;

/**
 * Fixed-rule ids live above every possible redirect id
 * (`MAX_SHARDS_PER_ENGINE * RULE_ID_SHARD_STRIDE`, currently 9600), so the
 * families can never collide however the sharding falls out. Raising
 * `MAX_SHARDS_PER_ENGINE` past 96 means raising these too.
 */
const ESCAPE_RULE_ID_BASE = 900_000;
const ALLOW_RULE_ID_BASE = 1_000_000;

/**
 * `chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES` is 5000 (30000 in
 * newer Chrome) and `MAX_NUMBER_OF_REGEX_RULES` is 1000: every rule we build
 * is a regex rule, so 1000 is the binding one. We stay comfortably under it
 * while leaving enough budget that the builtin registry plus a realistic custom
 * profile is covered with nothing dropped: the builtins alone need 60 rules
 * (18 shards x 3 engines, plus 3 allow and 3 escape).
 */
export const MAX_RULES = 300;

// ---------------------------------------------------------------- the plan ----

/**
 * One redirect rule per (engine, shard), plus an allow rule and a force-search
 * escape rule per engine.
 *
 * The capture group spans the *entire* `q` value, keyword and arguments, so
 * `regexSubstitution` can hand go.html the untouched query and let the pure
 * resolver do the real work. The keyword must be followed by an encoded space,
 * a `&`, a `#` or the end of the url, which is what stops `gh` from hijacking a
 * search for `ghost`.
 *
 * The whole set is built here rather than assembled by `syncRules`, so a rule
 * family can never be registered without its counterpart.
 *
 * DEPENDS ON `web_accessible_resources` in manifest.json listing go.html for
 * these engines' origins: a DNR redirect to an extension page is blocked
 * outright when the resource is not web-accessible. Removing that entry breaks
 * every rule built here, silently.
 */
export function buildRules(
  keywords: string[],
  engines: SearchEngine[],
  extensionId: string,
): chrome.declarativeNetRequest.Rule[] {
  const plan = planRedirects(keywords, engines, extensionId);
  if (plan.length === 0) return [];

  // Allow and escape rules first, so the `MAX_RULES` cap can only ever cost us
  // keywords, never the escape hatch.
  const rules: chrome.declarativeNetRequest.Rule[] = [
    ...buildAllowRules(engines),
    ...buildEscapeRules(engines, extensionId),
  ];
  for (const planned of plan) {
    if (rules.length >= MAX_RULES) break;
    rules.push(planned.rule);
  }
  return rules;
}

/** A redirect rule together with the keywords it covers, so `syncRules` can resplit it. */
export interface PlannedRule {
  engine: SearchEngine;
  keywords: string[];
  rule: chrome.declarativeNetRequest.Rule;
}

/**
 * Shard-major, every engine's copy of shard 0, then every engine's shard 1,
 * so running out of rule budget costs the same keywords on every engine. Engine
 * order would instead leave google fully covered and bing blind, which is worse
 * and much harder to explain.
 */
export function planRedirects(
  keywords: string[],
  engines: SearchEngine[],
  extensionId: string,
): PlannedRule[] {
  if (!extensionId) return [];
  const ranked = rankKeywords(keywords);
  if (ranked.length === 0 || engines.length === 0) return [];

  const plan: PlannedRule[] = [];
  shardKeywords(ranked).forEach((shard, shardIndex) => {
    engines.forEach((engine, engineIndex) => {
      const id = shardIndex * RULE_ID_SHARD_STRIDE + engineIndex + 1;
      plan.push({ engine, keywords: shard, rule: redirectRule(engine, shard, id, extensionId) });
    });
  });
  return plan;
}

// ---------------------------------------------------- the rules themselves ----

export function redirectRule(
  engine: SearchEngine,
  keywords: string[],
  id: number,
  extensionId: string,
): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: REDIRECT_PRIORITY,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { regexSubstitution: `chrome-extension://${extensionId}/go.html?q=\\1` },
    },
    condition: {
      regexFilter: buildRegexFilter(engine, keywords),
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
      isUrlFilterCaseSensitive: false,
      // A query typed into the engine's own search box on the results page is an
      // explicit search, not an address-bar shortcut. Without this, searching
      // Google for `new york times` from Google is rewritten.
      excludedInitiatorDomains: initiatorDomains(engine),
    },
  };
}

/**
 * One `allow` rule per engine for urls carrying `PASSTHROUGH_PARAM`.
 *
 * Anchored on the engine host rather than on `urlPrefixPattern`, because the
 * marker can sit anywhere in the query string and the prefix pattern ends at
 * `q=`.
 */
export function buildAllowRules(engines: SearchEngine[]): chrome.declarativeNetRequest.Rule[] {
  return engines.map((engine, engineIndex) => ({
    id: ALLOW_RULE_ID_BASE + engineIndex + 1,
    priority: ALLOW_PRIORITY,
    action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      regexFilter: `^https://${escapeRegex(engine.host)}/[^#]*[?&]${PASSTHROUGH_PARAM}=`,
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
      isUrlFilterCaseSensitive: false,
    },
  }));
}

/**
 * One redirect rule per engine for a query value that BEGINS with a force-search
 * escape, in every form the character can reach a search URL in.
 *
 * Chrome percent-encodes a typed `\` into the `q` value as `%5C` and an `=` as
 * `%3D`, but neither is guaranteed: which characters an engine template escapes
 * has changed across Chrome releases, and a query pasted from elsewhere can
 * carry the raw character. Matching both forms is why this rule works on
 * purpose rather than by accident: the old behaviour was that `%5C` matched
 * nothing, the navigation left the browser, and Google searched for a literal
 * `\gh foo` with the backslash glued to the terms.
 *
 * The capture keeps the escape character, because go.ts hands the whole value
 * to `resolve()` and `resolve()` is the one place that knows how to strip it.
 */
export function buildEscapeRules(
  engines: SearchEngine[],
  extensionId: string,
): chrome.declarativeNetRequest.Rule[] {
  if (!extensionId) return [];
  return engines.map((engine, engineIndex) => ({
    id: ESCAPE_RULE_ID_BASE + engineIndex + 1,
    priority: ESCAPE_PRIORITY,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { regexSubstitution: `chrome-extension://${extensionId}/go.html?q=\\1` },
    },
    condition: {
      regexFilter: escapeRegexFilter(engine),
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
      isUrlFilterCaseSensitive: false,
      // Same reasoning as the keyword rules: typing `=foo` into Google's own
      // search box is an explicit search, not an address-bar escape.
      excludedInitiatorDomains: initiatorDomains(engine),
    },
  }));
}

// ------------------------------------------------------- pattern fragments ----

/** Matched after the keyword: an encoded space plus the rest of the value. */
const KEYWORD_TAIL = '(?:(?:%20|\\+)[^&#]*)?';

/**
 * Everything after the query value, up to the end of the url.
 *
 * DNR replaces the *entire matched substring* with `regexSubstitution`, so the
 * match has to swallow the trailing parameters Chrome's engine templates always
 * append (`&sourceid=chrome&ie=UTF-8`, `&PC=U316&FORM=CHROMN`, `&t=hc`).
 * Ending the match at the terminator instead would leave them glued onto the
 * redirected query. RE2 has no lookahead, hence a consuming group rather than
 * `(?=[&#]|$)`.
 */
const VALUE_END = '(?:[&#].*)?$';

function buildRegexFilter(engine: SearchEngine, keywords: string[]): string {
  const alternation = keywords.map(escapeRegex).join('|');
  return `${engine.urlPrefixPattern}((?:${alternation})${KEYWORD_TAIL})${VALUE_END}`;
}

/**
 * Raw and percent-encoded forms of every escape, deduped. `encodeURIComponent`
 * rather than a literal `%5C`, so adding a prefix to `FORCE_SEARCH_PREFIXES` is
 * the only edit needed.
 */
function escapeAlternatives(): string[] {
  const forms = new Set<string>();
  for (const prefix of FORCE_SEARCH_PREFIXES) {
    forms.add(escapeRegex(prefix));
    forms.add(escapeRegex(encodeURIComponent(prefix)));
  }
  return [...forms];
}

function escapeRegexFilter(engine: SearchEngine): string {
  return `${engine.urlPrefixPattern}((?:${escapeAlternatives().join('|')})[^&#]*)${VALUE_END}`;
}

/**
 * The engine host plus its registrable domain, so a search started from
 * `google.com` is excluded as well as one from `www.google.com`.
 */
function initiatorDomains(engine: SearchEngine): string[] {
  const host = engine.host;
  const naked = host.replace(/^www\./, '');
  return naked === host ? [host] : [host, naked];
}
