/**
 * declarativeNetRequest rules that turn a search-results navigation into a
 * BunnyLol dispatch.
 *
 * The user types `gh facebook/react` in the address bar, Chrome decides it is
 * not a URL and starts navigating to google.com/search?q=gh+facebook%2Freact,
 * and a DNR redirect rule catches that main-frame request before it leaves the
 * browser and rewrites it to go.html?q=gh+facebook%2Freact. No request is ever
 * sent to the search engine.
 *
 * `buildRules` is pure — it never touches `chrome.*` — so the regex generation
 * is unit-testable in Node. `syncRules` registers the very same patterns, but
 * asks Chrome to validate each one first and splits the ones it rejects, which
 * is inherently async and so lives on the browser side of the line.
 */

import { BUILTIN_COMMANDS, SEARCH_ENGINES } from './commands';
import { activeKeywords } from './resolve';
import { loadResolveContext } from './storage';
import { errorText } from './text';
import { DEFAULT_STOP_LIST, FORCE_SEARCH_PREFIXES, PASSTHROUGH_PARAM } from './types';
import type { RuleStatus, SearchEngine, SearchEngineId } from './types';

/**
 * Three tiers, and the order between them is the whole escape hatch.
 *
 * `allow` outranks everything: it is what stops a BunnyLol-generated fallback
 * search (anything go.ts sends to the default engine) from being caught by our
 * own redirect and bounced back into the command the user was escaping.
 *
 * `escape` sits between the two so a query beginning with a
 * `FORCE_SEARCH_PREFIXES` character can never be claimed by a keyword rule
 * first. In practice no keyword alternation can match one — the value starts
 * with `\`, `=` or a `%` escape, and no alias may contain those — but the
 * escape hatch is load-bearing enough that it should not depend on a property
 * of the alias charset that a later change could quietly relax.
 */
const REDIRECT_PRIORITY = 1;
const ESCAPE_PRIORITY = 2;
const ALLOW_PRIORITY = 3;

/**
 * Chrome compiles each `regexFilter` with `RE2::Options::set_max_mem(2 * 1024)`,
 * and a pattern that busts that budget is simply reported unsupported — the rule
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

/**
 * How many times an unsupported shard may be halved before we conclude the
 * keyword itself is the problem. 2^6 pieces is past the point where a shard
 * holds more than one keyword.
 */
const MAX_SPLIT_DEPTH = 6;

/**
 * Rule ids are `shard * STRIDE + engineIndex + 1`, so the common single-shard
 * case yields 1, 2, 3 — one per engine — and shards never collide.
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

/** Where the last `syncRules` outcome is parked for the next worker instance. */
const STATUS_KEY = 'bunnylol.ruleStatus.v1';

/**
 * `chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES` is 5000 (30000 in
 * newer Chrome) and `MAX_NUMBER_OF_REGEX_RULES` is 1000 — every rule we build
 * is a regex rule, so 1000 is the binding one. We stay comfortably under it
 * while leaving enough budget that the builtin registry plus a realistic custom
 * profile is covered with nothing dropped: the builtins alone need 60 rules
 * (18 shards x 3 engines, plus 3 allow and 3 escape).
 */
export const MAX_RULES = 300;

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

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * One redirect rule per (engine, shard), plus an allow rule and a force-search
 * escape rule per engine.
 *
 * The capture group spans the *entire* `q` value — keyword and arguments — so
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
interface PlannedRule {
  engine: SearchEngine;
  keywords: string[];
  rule: chrome.declarativeNetRequest.Rule;
}

/**
 * Shard-major — every engine's copy of shard 0, then every engine's shard 1 —
 * so running out of rule budget costs the same keywords on every engine. Engine
 * order would instead leave google fully covered and bing blind, which is worse
 * and much harder to explain.
 */
function planRedirects(
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

function redirectRule(
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
function buildAllowRules(engines: SearchEngine[]): chrome.declarativeNetRequest.Rule[] {
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
 * purpose rather than by accident — the old behaviour was that `%5C` matched
 * nothing, the navigation left the browser, and Google searched for a literal
 * `\gh foo` with the backslash glued to the terms.
 *
 * The capture keeps the escape character, because go.ts hands the whole value
 * to `resolve()` and `resolve()` is the one place that knows how to strip it.
 */
function buildEscapeRules(
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

/** The rebuild currently in flight, or `null` when nothing is running. */
let chain: Promise<RuleStatus> | null = null;

/**
 * The one follow-up rebuild shared by every caller that arrived mid-flight.
 * Non-null from the moment it is scheduled until the moment it starts.
 */
let trailing: Promise<RuleStatus> | null = null;

/**
 * Rebuilds the dynamic rule set from stored state, serialized. Never rejects: a
 * failed rebuild is reported through `RuleStatus.error` and mere partial
 * coverage through `RuleStatus.warning`, because an exception here would take
 * down the service worker and with it the omnibox.
 *
 * Serialized because rule ids are renumbered densely from the current keyword
 * count, so two rebuilds that overlap fight over one id space: the older run
 * removes the ids it read before the newer run added them, `updateDynamicRules`
 * rejects the duplicate, and `failClosed` then tears the whole dynamic table
 * down. A burst of saves — which is exactly what onboarding produces, one
 * `onStateChanged` each — is that pattern.
 *
 * One trailing slot, not a queue of N: every caller that arrives while a
 * rebuild is in flight shares a single follow-up run, so N concurrent calls
 * cost at most two rule writes. Every caller still resolves with the status of
 * a run that STARTED AFTER its own call, so nobody is handed a status that
 * predates the state they just saved.
 */
export function syncRules(): Promise<RuleStatus> {
  // `trailing` is checked FIRST and on its own: `chain` is cleared when a
  // rebuild settles, which is a microtask or two before the follow-up it
  // scheduled actually starts. A caller landing in that gap sees no rebuild in
  // flight, and if it only consulted `chain` it would open a second one
  // alongside the follow-up that is about to run — the very overlap this
  // serialization exists to prevent. A scheduled-but-unstarted follow-up still
  // starts after this call, so sharing it keeps the freshness guarantee.
  const scheduled = trailing;
  if (scheduled) return scheduled;
  if (!chain) return start();
  // `runSync` reports failure through `RuleStatus.error` rather than rejecting,
  // but a rejection must not be able to strand the queue, so the follow-up is
  // scheduled from both settlement paths.
  trailing = chain.then(startTrailing, startTrailing);
  return trailing;
}

function startTrailing(): Promise<RuleStatus> {
  trailing = null;
  return start();
}

function start(): Promise<RuleStatus> {
  const run: Promise<RuleStatus> = runSync().finally(() => {
    if (chain === run) chain = null;
  });
  chain = run;
  return run;
}

/**
 * One rebuild of the dynamic rule set from stored state. Never throws: a failed
 * sync is reported through `RuleStatus.error` and mere partial coverage through
 * `RuleStatus.warning`, because an exception here would take down the service
 * worker and with it the omnibox.
 *
 * Reached only through `syncRules`, which serializes the rebuilds.
 */
async function runSync(): Promise<RuleStatus> {
  const extensionId = chrome.runtime.id;
  let eligible = 0;
  let suppressed = 0;

  try {
    const { commands, settings } = await loadResolveContext();
    const stopList = settings.interceptStopList ?? DEFAULT_STOP_LIST;
    const keywords = activeKeywords(commands, stopList);
    eligible = keywords.length;
    // Only interception is suppressed; every one of these aliases still
    // resolves from the `bl` omnibox and the popup.
    suppressed = activeKeywords(commands).length - eligible;

    const intercepted = new Set<SearchEngineId>(settings.interceptEngines ?? []);
    const engines = SEARCH_ENGINES.filter((engine) => intercepted.has(engine.id));
    const plan = planRedirects(keywords, engines, extensionId);
    const fitted = await fitPlan(plan, engines, keywords, extensionId);
    // Nothing was planned when the user selected no engines, so nothing was
    // dropped either: reporting `eligible` here told someone who deliberately
    // turned interception off that they had hit a quota.
    const dropped = engines.length === 0 ? 0 : eligible - fitted.covered;

    // Read the ids back rather than assuming our own numbering: a previous
    // build may have used a different sharding and left rules we must clear.
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map((rule) => rule.id),
        addRules: fitted.rules,
      });
    } catch (err) {
      return await rememberStatus(await failClosed(err, extensionId, suppressed, eligible));
    }

    return await rememberStatus({
      // Counted from the browser, not from what we asked for: the options page
      // pill must not claim rules that Chrome refused.
      registered: await countDynamicRules(),
      keywords: fitted.covered,
      suppressed,
      dropped,
      error: null,
      warning: engines.length === 0 ? null : describeCoverage(fitted, dropped),
      extensionId,
    });
  } catch (err) {
    // We never reached the replacement, so whatever the last successful sync
    // registered is still live and still intercepting. Reporting zero coverage
    // here — as this used to — describes a browser state that does not exist.
    const live = (await lastRuleStatus())?.keywords ?? 0;
    return await rememberStatus({
      registered: await countDynamicRules(),
      keywords: live,
      suppressed,
      dropped: Math.max(eligible - live, 0),
      error: errorText(err),
      warning: null,
      extensionId,
    });
  }
}

/**
 * `updateDynamicRules` is atomic, so a rejected update leaves the PREVIOUS rule
 * set live and untouched rather than leaving nothing behind.
 *
 * Those survivors are not a harmless leftover. They were built for the state
 * the user has just changed — an alias they disabled, an engine they unchecked,
 * a reload under a new extension id — and a redirect rule that outlives its
 * matching allow and escape rules is precisely the redirect loop the priority
 * tiers exist to prevent, with the options page meanwhile reporting that
 * interception is off. So the failure path tears the whole dynamic table down,
 * and when even that is refused it says what is still running instead of
 * claiming zero.
 */
async function failClosed(
  err: unknown,
  extensionId: string,
  suppressed: number,
  eligible: number,
): Promise<RuleStatus> {
  const reason = errorText(err);
  // Read before the teardown: it describes the rules that are live right now.
  const stale = await lastRuleStatus();

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: [],
    });
  } catch (removeErr) {
    const live = stale?.keywords ?? 0;
    return {
      registered: await countDynamicRules(),
      keywords: live,
      suppressed,
      dropped: Math.max(eligible - live, 0),
      error: `Rule sync failed (${reason}) and the rules from the last sync could not be removed either (${errorText(removeErr)}). Address-bar interception is still running on those older rules, so a shortcut you just changed may still go to its old destination — reload the extension.`,
      warning: null,
      extensionId,
    };
  }

  return {
    registered: await countDynamicRules(),
    keywords: 0,
    suppressed,
    dropped: eligible,
    error: `Rule sync failed: ${reason}. Address-bar interception is off — the rules from the last sync were removed rather than left running against settings they no longer match.`,
    warning: null,
    extensionId,
  };
}

/**
 * The outcome of the last sync, or null when this browser session has not run
 * one. Reported by the options page instead of a freshly invented "everything
 * is fine", which is what hid partial failures before.
 */
export async function lastRuleStatus(): Promise<RuleStatus | null> {
  const area = sessionArea();
  if (area) {
    try {
      const bag = await area.get(STATUS_KEY);
      const stored = bag?.[STATUS_KEY];
      if (isRuleStatus(stored)) return stored;
    } catch {
      // Session storage unavailable (or wiped); fall back to this instance.
    }
  }
  return cachedStatus;
}

/**
 * An MV3 worker is torn down after ~30s idle, so a module-level variable alone
 * would forget the last sync almost immediately. `chrome.storage.session` is
 * per-browser-session and never hits disk, which is exactly the lifetime a rule
 * status should have; the module copy only covers builds where it is missing.
 */
let cachedStatus: RuleStatus | null = null;

async function rememberStatus(status: RuleStatus): Promise<RuleStatus> {
  cachedStatus = status;
  const area = sessionArea();
  if (area) {
    try {
      await area.set({ [STATUS_KEY]: status });
    } catch {
      // Storing the status must never fail the sync it describes.
    }
  }
  return status;
}

function sessionArea(): chrome.storage.StorageArea | null {
  try {
    return typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null;
  } catch {
    return null;
  }
}

function isRuleStatus(value: unknown): value is RuleStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<RuleStatus>;
  return (
    typeof status.registered === 'number' &&
    typeof status.keywords === 'number' &&
    // A status stored by an older build has no `dropped`, and one stored before
    // `error` was split has no `warning`; rejecting those here is what stops the
    // options page from rendering "undefined dropped" or silently losing the
    // partial-coverage message.
    typeof status.dropped === 'number' &&
    (typeof status.warning === 'string' || status.warning === null)
  );
}

function buildRegexFilter(engine: SearchEngine, keywords: string[]): string {
  const alternation = keywords.map(escapeRegex).join('|');
  return `${engine.urlPrefixPattern}((?:${alternation})${KEYWORD_TAIL})${VALUE_END}`;
}

/**
 * Every alias this build ships, lowercased. Only used to RANK keywords for
 * retention: a user with 400 imported shortcuts must not lose `gh` to them.
 */
const BUILTIN_ALIASES = new Set<string>(
  BUILTIN_COMMANDS.flatMap((cmd) => cmd.keys ?? []).map((key) => key.trim().toLowerCase()),
);

/** Lowercased (the rules match case-insensitively) and deduped, order untouched. */
function dedupeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  for (const keyword of keywords ?? []) {
    const alias = (keyword ?? '').trim().toLowerCase();
    if (alias) seen.add(alias);
  }
  return [...seen];
}

/**
 * TWO ORDERS, ONE LIST — the subtle part of this file.
 *
 * `rankKeywords` decides WHICH keywords survive: the shard cap and the rule
 * budget both truncate the tail of this order, so it must put the keywords a
 * user would miss most at the front — builtins before custom shortcuts, and
 * shorter (hotter, and cheaper in the alternation) before longer.
 *
 * `alternationOrder` decides how the survivors are WRITTEN into one rule's
 * regex: longest-first, so the alternation offers `github` before `gh`.
 *
 * Ranking longest-first, as this used to, made the two the same order and cut
 * from the wrong end — `gh`, `g` and `npm` were the first aliases dropped once
 * a few hundred custom commands pushed past the budget.
 */
function rankKeywords(keywords: string[]): string[] {
  return dedupeKeywords(keywords).sort((a, b) => {
    const builtin = Number(BUILTIN_ALIASES.has(b)) - Number(BUILTIN_ALIASES.has(a));
    if (builtin !== 0) return builtin;
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  });
}

function alternationOrder(keywords: string[]): string[] {
  return [...keywords].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Splits the alternation across rules to stay under the per-rule regex budget.
 * Every shard captures the same thing for a given url, so it does not matter
 * which shard Chrome picks when two of them match.
 *
 * Keywords beyond `MAX_SHARDS_PER_ENGINE` shards are dropped: they still work
 * from the omnibox and the popup, they just are not intercepted from the search
 * engine. Silently dropping beats failing the whole sync.
 */
function shardKeywords(keywords: string[]): string[][] {
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

function escapeRegex(value: string): string {
  return value.replace(REGEX_META, '\\$&');
}

interface FittedPlan {
  rules: chrome.declarativeNetRequest.Rule[];
  /** Aliases intercepted on EVERY selected engine — the number worth showing a user. */
  covered: number;
  /** Aliases Chrome refused to compile a pattern for, even on their own. */
  rejected: string[];
  /** Labels of engines left uninterceptable because Chrome refused their allow rule. */
  unguarded: string[];
}

/**
 * Turns a plan into the rule set we actually register: every regex validated by
 * Chrome first, oversized shards halved instead of dropped, and the whole thing
 * held under `MAX_RULES`.
 *
 * `updateDynamicRules` is all-or-nothing, so shipping one unsupported pattern
 * would leave the user with zero interception — indistinguishable from a broken
 * extension.
 */
async function fitPlan(
  plan: PlannedRule[],
  engines: SearchEngine[],
  keywords: string[],
  extensionId: string,
): Promise<FittedPlan> {
  if (plan.length === 0) return { rules: [], covered: 0, rejected: [], unguarded: [] };

  // An engine's allow rule is a PRECONDITION for its redirect rules, not an
  // independent nicety. A redirect pattern still matches BunnyLol's own marked
  // searches — `blpass` sits past the end of the captured `q` value, where the
  // pattern swallows it as a trailing parameter — so the only thing keeping
  // `weather boston` out of an infinite go.html loop, and `\gh foo` out of the
  // command it escapes, is the higher-priority allow rule winning first.
  // Registering redirects for an engine whose allow rule Chrome refused is
  // therefore worse than not intercepting that engine at all.
  //
  // The escape rule is a precondition for the same reason. Without it a typed
  // `\gh foo` is not intercepted at all, so the backslash reaches the engine as
  // a search term and the user's only escape hatch silently stops working —
  // and, unlike a missing keyword rule, they get no search either.
  const fixed: chrome.declarativeNetRequest.Rule[] = [];
  const guarded = new Set<SearchEngineId>();
  const allowPlan = buildAllowRules(engines);
  const escapePlan = buildEscapeRules(engines, extensionId);
  for (const [index, allowRule] of allowPlan.entries()) {
    const escapeRule = escapePlan[index];
    if (!(await isSupported(allowRule)) || !(await isSupported(escapeRule))) continue;
    fixed.push(allowRule, escapeRule);
    guarded.add(engines[index].id);
  }
  const unguarded = engines.filter((engine) => !guarded.has(engine.id));

  const budget = MAX_RULES - fixed.length;
  const redirects: chrome.declarativeNetRequest.Rule[] = [];
  const rejected = new Set<string>();
  const coveredPerEngine = new Map<SearchEngineId, Set<string>>();

  for (const planned of plan) {
    if (redirects.length >= budget) break;
    if (!guarded.has(planned.engine.id)) continue;
    const { pieces, rejected: refused } = await splitUntilSupported(planned, extensionId, 0);
    for (const keyword of refused) rejected.add(keyword);
    for (const piece of pieces) {
      // Out of budget: the piece is dropped, and its keywords stay uncovered
      // rather than being counted as intercepted.
      if (redirects.length >= budget) break;
      // Ids are provisional until here, because splitting invents rules the
      // shard numbering never allotted an id to.
      redirects.push({ ...piece.rule, id: redirects.length + 1 });
      const covered = coveredPerEngine.get(piece.engine.id) ?? new Set<string>();
      coveredPerEngine.set(piece.engine.id, covered);
      for (const keyword of piece.keywords) covered.add(keyword);
    }
  }

  const sets = engines.map((engine) => coveredPerEngine.get(engine.id) ?? new Set<string>());
  const covered = dedupeKeywords(keywords).filter((keyword) =>
    sets.every((set) => set.has(keyword)),
  ).length;

  return {
    rules: [...fixed, ...redirects],
    covered,
    rejected: [...rejected],
    unguarded: unguarded.map((engine) => engine.label),
  };
}

/**
 * Chrome's RE2 budget is on the compiled program, so the only way to know a
 * shard fits is to ask. A rejected shard is halved and each half re-checked:
 * dropping the whole shard would cost every keyword in it for one pattern that
 * was merely too wide.
 */
async function splitUntilSupported(
  planned: PlannedRule,
  extensionId: string,
  depth: number,
): Promise<{ pieces: PlannedRule[]; rejected: string[] }> {
  if (await isSupported(planned.rule)) return { pieces: [planned], rejected: [] };
  if (planned.keywords.length < 2 || depth >= MAX_SPLIT_DEPTH) {
    return { pieces: [], rejected: planned.keywords };
  }

  const middle = Math.ceil(planned.keywords.length / 2);
  const pieces: PlannedRule[] = [];
  const rejected: string[] = [];
  for (const half of [planned.keywords.slice(0, middle), planned.keywords.slice(middle)]) {
    const outcome = await splitUntilSupported(
      {
        engine: planned.engine,
        keywords: half,
        rule: redirectRule(planned.engine, half, planned.rule.id, extensionId),
      },
      extensionId,
      depth + 1,
    );
    pieces.push(...outcome.pieces);
    rejected.push(...outcome.rejected);
  }
  return { pieces, rejected };
}

async function isSupported(rule: chrome.declarativeNetRequest.Rule): Promise<boolean> {
  const regex = rule.condition.regexFilter;
  if (!regex) return false;
  try {
    const check = await chrome.declarativeNetRequest.isRegexSupported({
      regex,
      isCaseSensitive: false,
      // Only the redirect rules feed a `\\1` substitution; demanding a capture
      // group from the allow rules would reject every one of them.
      requireCapturing: rule.action.redirect?.regexSubstitution != null,
    });
    return check.isSupported === true;
  } catch {
    // The validator itself is unavailable (older Chrome, a stubbed test
    // environment); let `updateDynamicRules` be the judge instead of dropping
    // every rule we have.
    return true;
  }
}

function describeCoverage(fitted: FittedPlan, dropped: number): string | null {
  if (fitted.unguarded.length > 0) {
    // Failing closed: the alternative is an interception loop the user cannot
    // escape without closing the tab.
    return `Interception is off for ${fitted.unguarded.join(', ')}: Chrome would not accept the ${PASSTHROUGH_PARAM} allow rule or the force-search escape rule, and redirect rules without both of those send BunnyLol's own searches back into the dispatch page and leave you no way to force an ordinary search.`;
  }
  const rejected = fitted.rejected;
  if (rejected.length > 0) {
    const shown = rejected.slice(0, 5).join(', ');
    const more = rejected.length > 5 ? `, +${rejected.length - 5} more` : '';
    return `${dropped} keyword(s) are not intercepted: Chrome rejected the pattern for ${shown}${more}.`;
  }
  if (dropped > 0) return `${dropped} keyword(s) are not intercepted: the rule budget is full.`;
  return null;
}

async function countDynamicRules(): Promise<number> {
  try {
    return (await chrome.declarativeNetRequest.getDynamicRules()).length;
  } catch {
    return 0;
  }
}
