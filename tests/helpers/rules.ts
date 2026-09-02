/**
 * Test scaffolding shared by the rule suites.
 *
 * Two things live here. `installChromeStub` is a `chrome` object complete
 * enough to run the REAL `syncRules()` in Node — storage, the dynamic-rule
 * table and `isRegexSupported` — so the production path can be tested instead
 * of the pure `buildRules` mirror of it. `claim`/`redirectTo` replay Chrome's
 * own matching against a rule set, so a test can ask what the browser would
 * actually do with a url rather than trusting a rule count.
 *
 * Not a suite: vitest only collects files ending in `.test.ts`.
 */

import { FORCE_SEARCH_PREFIXES, STORAGE_KEY } from '../../src/lib/types';
import type { SearchEngine, StoredState } from '../../src/lib/types';

export const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

export interface ChromeStub {
  /** The dynamic rules Chrome is currently holding, as `syncRules` left them. */
  rules(): chrome.declarativeNetRequest.Rule[];
  /** Every regex `syncRules` asked Chrome to validate, in order. */
  probed: string[];
  /** How many times `updateDynamicRules` was called. */
  updates: number;
  restore(): void;
}

export interface StubOptions {
  /** What `chrome.storage.local` hands back; omitted means an empty profile. */
  state?: StoredState;
  /** Stands in for Chrome's RE2 check. Defaults to accepting every pattern. */
  supports?: (regex: string) => boolean;
  /**
   * A Chrome that refuses a write. Returns the message to reject the nth
   * (1-based) `updateDynamicRules` call with, or null to let it through.
   *
   * The call is REJECTED WITHOUT CHANGING THE TABLE, which is the behaviour
   * that matters: `updateDynamicRules` is atomic, so the rules from the last
   * successful sync are still live afterwards.
   */
  rejectUpdate?: (call: number, update: DynamicRuleUpdate) => string | null;
  /**
   * Chrome's own duplicate-id check: an add whose id is still present once
   * `removeRuleIds` have been applied is refused, and — like every refusal —
   * the whole call is refused WITHOUT CHANGING THE TABLE.
   *
   * Off by default, because it only matters for the suites that drive more
   * than one rebuild at a time.
   */
  strictIds?: boolean;
  extensionId?: string;
}

export interface DynamicRuleUpdate {
  removeRuleIds?: number[];
  addRules?: chrome.declarativeNetRequest.Rule[];
}

/** Replaces `globalThis.chrome`; call `restore()` when the test is done. */
export function installChromeStub(options: StubOptions = {}): ChromeStub {
  const supports = options.supports ?? (() => true);
  let dynamic: chrome.declarativeNetRequest.Rule[] = [];
  const session = new Map<string, unknown>();
  const local = new Map<string, unknown>();
  if (options.state) local.set(STORAGE_KEY, options.state);

  const stub: ChromeStub = {
    rules: () => dynamic,
    probed: [],
    updates: 0,
    restore: () => {
      globals.chrome = previous;
    },
  };

  const area = (bag: Map<string, unknown>) => ({
    get: async (key: string) => (bag.has(key) ? { [key]: bag.get(key) } : {}),
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) bag.set(key, value);
    },
  });

  const chromeStub = {
    runtime: { id: options.extensionId ?? EXT_ID },
    storage: { local: area(local), session: area(session) },
    declarativeNetRequest: {
      getDynamicRules: async () => [...dynamic],
      updateDynamicRules: async (update: DynamicRuleUpdate) => {
        stub.updates += 1;
        const refusal = options.rejectUpdate?.(stub.updates, update) ?? null;
        if (refusal) throw new Error(refusal);
        const removed = new Set(update.removeRuleIds ?? []);
        const survivors = dynamic.filter((rule) => !removed.has(rule.id));
        if (options.strictIds) {
          const taken = new Set(survivors.map((rule) => rule.id));
          for (const rule of update.addRules ?? []) {
            if (taken.has(rule.id)) throw new Error(`Rule with id ${rule.id} already exists.`);
          }
        }
        dynamic = [...survivors, ...(update.addRules ?? [])];
      },
      isRegexSupported: async (check: { regex: string }) => {
        stub.probed.push(check.regex);
        return { isSupported: supports(check.regex) };
      },
    },
  };

  const globals = globalThis as unknown as { chrome?: unknown };
  const previous = globals.chrome;
  globals.chrome = chromeStub;
  return stub;
}

/** Chrome matches every rule we build case-insensitively. */
export function compile(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

export function matches(rule: chrome.declarativeNetRequest.Rule, url: string): boolean {
  return compile(rule.condition.regexFilter as string).test(url);
}

export function priorityOf(rule: chrome.declarativeNetRequest.Rule): number {
  return rule.priority ?? 1;
}

/**
 * Which action Chrome would take for `url`: the highest-priority matching rule
 * wins, and `allow` beats `redirect` at equal priority. `null` when no rule
 * matches at all.
 *
 * A redirect rule's regex can still *match* one of our own marked searches —
 * `blpass=1` sits past the end of the captured `q` value, where the pattern
 * happily swallows it as a trailing parameter. What makes the marker work is
 * the higher-priority allow rule claiming the url first, so "no redirect rule
 * matches" is the wrong question to ask; "would Chrome redirect this" is the
 * right one.
 */
export function claim(
  rules: chrome.declarativeNetRequest.Rule[],
  url: string,
): 'allow' | 'redirect' | null {
  const matching = rules.filter((rule) => matches(rule, url));
  if (matching.length === 0) return null;
  const top = Math.max(...matching.map(priorityOf));
  const winners = matching.filter((rule) => priorityOf(rule) === top);
  if (winners.some((rule) => rule.action.type === 'allow')) return 'allow';
  return 'redirect';
}

/**
 * The url Chrome would navigate to, for a url the redirect rules do claim.
 *
 * HIGHEST PRIORITY WINS, not array order: the force-search escape rule and a
 * keyword rule are both redirects, and which of them Chrome applies is the
 * whole point of the priority tiers. Picking the first match in the array would
 * make this helper agree with the rule builder by accident.
 */
export function redirectTo(
  rules: chrome.declarativeNetRequest.Rule[],
  url: string,
): string | null {
  const matching = rules.filter((rule) => rule.action.type === 'redirect' && matches(rule, url));
  if (matching.length === 0) return null;
  const top = Math.max(...matching.map(priorityOf));
  const rule = matching.find((candidate) => priorityOf(candidate) === top) as chrome.declarativeNetRequest.Rule;
  const pattern = compile(rule.condition.regexFilter as string);
  const substitution = rule.action.redirect?.regexSubstitution as string;
  return url.replace(pattern, substitution.replace(/\\(\d)/g, '$$$1'));
}

/**
 * The force-search escape rules are `redirect` rules too, so "every redirect
 * rule" is no longer the same set as "every keyword rule". Told apart by the
 * percent-encoded escape in the pattern, which no alias can contain:
 * `activeKeywords` rejects anything outside `[a-z0-9_-]`.
 */
export function isEscapeRule(rule: chrome.declarativeNetRequest.Rule): boolean {
  if (rule.action.type !== 'redirect') return false;
  const pattern = rule.condition.regexFilter ?? '';
  return FORCE_SEARCH_PREFIXES.some((prefix) => pattern.includes(encodeURIComponent(prefix)));
}

export function escapeRulesOf(
  rules: chrome.declarativeNetRequest.Rule[],
): chrome.declarativeNetRequest.Rule[] {
  return rules.filter(isEscapeRule);
}

/** Redirect rules built from the keyword alternation — the escape rules excluded. */
export function keywordRulesOf(
  rules: chrome.declarativeNetRequest.Rule[],
): chrome.declarativeNetRequest.Rule[] {
  return rules.filter((rule) => rule.action.type === 'redirect' && !isEscapeRule(rule));
}

/** A results url of the shape Chrome's address bar produces for this engine. */
export function resultsUrl(engine: SearchEngine, query: string): string {
  const path = engine.id === 'duckduckgo' ? '/' : '/search';
  return `https://${engine.host}${path}?q=${query}`;
}
