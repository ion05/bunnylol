/**
 * The rule path the extension actually runs.
 *
 * `background.ts` never calls `buildRules`; it calls `syncRules`, which plans
 * the same patterns but then validates every one against
 * `chrome.declarativeNetRequest.isRegexSupported`, splits what Chrome refuses,
 * fits the result into the rule budget and reports a `RuleStatus`. Everything
 * below drives that real function through a `chrome` stub and then asks what
 * the REGISTERED rules would do to a navigation — a status that claims coverage
 * the rules do not deliver is the failure mode these tests exist to catch.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { MAX_RULES, syncRules } from '../src/lib/dnr';
import { activeKeywords, mergeCommands, resolve } from '../src/lib/resolve';
import type { Command, RuleStatus, SearchEngine, SearchEngineId, StoredState } from '../src/lib/types';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  DEFAULT_STOP_LIST,
  FORCE_SEARCH_PREFIXES,
  PASSTHROUGH_PARAM,
} from '../src/lib/types';
import type { ChromeStub, StubOptions } from './helpers/rules';
import {
  EXT_ID,
  claim,
  escapeRulesOf,
  installChromeStub,
  keywordRulesOf,
  redirectTo,
  resultsUrl,
} from './helpers/rules';

let stub: ChromeStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

function state(overrides: Partial<StoredState['settings']> = {}, custom: Command[] = []): StoredState {
  return {
    overrides: { ...DEFAULT_OVERRIDES, custom },
    settings: { ...DEFAULT_SETTINGS, ...overrides },
  };
}

async function sync(options: StubOptions): Promise<{ status: RuleStatus; rules: chrome.declarativeNetRequest.Rule[] }> {
  stub = installChromeStub(options);
  const status = await syncRules();
  return { status, rules: stub.rules() };
}

function enginesOf(ids: SearchEngineId[]): SearchEngine[] {
  return SEARCH_ENGINES.filter((engine) => ids.includes(engine.id));
}

function eligible(stored: StoredState): string[] {
  return activeKeywords(
    mergeCommands(BUILTIN_COMMANDS, stored.overrides),
    stored.settings.interceptStopList,
  );
}

/**
 * The coverage the registered rules really deliver: an alias counts only when a
 * typed `<alias> foo` is redirected into the dispatch page on EVERY selected
 * engine, with the query handed over intact. This is what `RuleStatus.keywords`
 * claims, computed independently of the code that fills it in.
 */
function coverage(
  rules: chrome.declarativeNetRequest.Rule[],
  keywords: string[],
  engines: SearchEngine[],
): string[] {
  if (engines.length === 0) return [];
  return keywords.filter((alias) =>
    engines.every((engine) => {
      const url = resultsUrl(engine, `${alias}+foo`);
      return (
        claim(rules, url) === 'redirect' &&
        redirectTo(rules, url) === `chrome-extension://${EXT_ID}/go.html?q=${alias}+foo`
      );
    }),
  );
}

function redirects(rules: chrome.declarativeNetRequest.Rule[]) {
  return keywordRulesOf(rules);
}

function allows(rules: chrome.declarativeNetRequest.Rule[]) {
  return rules.filter((rule) => rule.action.type === 'allow');
}

describe('the status syncRules reports matches the rules it registered', () => {
  it('claims exactly the coverage the registered rules deliver', async () => {
    const stored = state();
    const { status, rules } = await sync({ state: stored });

    expect(status.error).toBeNull();
    expect(status.warning).toBeNull();
    expect(status.registered).toBe(rules.length);
    expect(rules.length).toBeLessThanOrEqual(MAX_RULES);
    expect(allows(rules).length).toBe(SEARCH_ENGINES.length);
    expect(escapeRulesOf(rules).length).toBe(SEARCH_ENGINES.length);

    const covered = coverage(rules, eligible(stored), SEARCH_ENGINES);
    expect(status.keywords).toBe(covered.length);
    expect(status.keywords + status.dropped).toBe(eligible(stored).length);
    expect(covered).toContain('gh');
    expect(covered).toContain('npm');
  });

  /**
   * The headline consequence of the empty exemption list: with every builtin
   * alias eligible, the rule budget has to cover ALL of them. A cap that drops
   * the tail is exactly the failure this suite exists to catch.
   */
  it('covers every builtin alias with nothing dropped and nothing exempted', async () => {
    const stored = state();
    const { status, rules } = await sync({ state: stored });
    const keywords = eligible(stored);

    expect(DEFAULT_STOP_LIST).toEqual([]);
    expect(keywords.length).toBeGreaterThan(300);
    expect(status.suppressed).toBe(0);
    expect(status.dropped).toBe(0);
    expect(status.keywords).toBe(keywords.length);
    expect(coverage(rules, keywords, SEARCH_ENGINES).length).toBe(keywords.length);
    expect(status.error).toBeNull();
    expect(status.warning).toBeNull();
  });

  it('counts a user exemption as suppressed, not dropped', async () => {
    const stored = state({ interceptStopList: ['maps', 'news'] });
    const { status } = await sync({ state: stored });
    const all = activeKeywords(mergeCommands(BUILTIN_COMMANDS, stored.overrides));
    expect(status.suppressed).toBe(all.length - eligible(stored).length);
    expect(status.suppressed).toBe(2);
    expect(status.dropped).toBe(0);
  });

  it('replaces the rules a previous sync left behind instead of stacking on them', async () => {
    stub = installChromeStub({ state: state() });
    const first = await syncRules();
    const second = await syncRules();
    expect(stub.updates).toBe(2);
    expect(stub.rules().length).toBe(second.registered);
    expect(second.registered).toBe(first.registered);
    expect(new Set(stub.rules().map((rule) => rule.id)).size).toBe(stub.rules().length);
  });
});

/**
 * A REJECTED UPDATE LEAVES THE OLD RULES RUNNING.
 *
 * `updateDynamicRules` is atomic, so when it throws the previous dynamic rules
 * are still installed — the failure path used to assume the opposite and report
 * `keywords: 0`, while sixty obsolete redirect rules kept intercepting. Those
 * survivors are the redirect-loop condition on their own: they were built for
 * settings the user has since changed, and the options page was meanwhile
 * saying interception was off.
 */
describe('a Chrome that rejects the rule update', () => {
  /** Succeeds once, then refuses every later write — including the teardown. */
  const refuseAfterFirst = (call: number) =>
    call === 1 ? null : 'Dynamic rule quota exceeded.';

  it('removes the stale rules rather than leaving them live', async () => {
    stub = installChromeStub({
      state: state(),
      // The replacement is refused; the remove-only retry behind it is allowed.
      rejectUpdate: (call) => (call === 2 ? 'Dynamic rule quota exceeded.' : null),
    });
    const first = await syncRules();
    expect(first.keywords).toBeGreaterThan(300);
    expect(stub.rules().length).toBeGreaterThan(0);

    const failed = await syncRules();

    expect(stub.rules()).toEqual([]);
    expect(failed.registered).toBe(0);
    expect(failed.keywords).toBe(0);
    expect(failed.error).toMatch(/quota/i);
    // The honest half: a status claiming zero coverage must be true of the
    // browser, and nothing may still be intercepted on any engine.
    for (const engine of SEARCH_ENGINES) {
      expect(claim(stub.rules(), resultsUrl(engine, 'gh+foo'))).toBeNull();
    }
  });

  it('reports the coverage still live when the removal is refused too', async () => {
    stub = installChromeStub({ state: state(), rejectUpdate: refuseAfterFirst });
    const first = await syncRules();
    const live = stub.rules().length;

    const failed = await syncRules();

    // Nothing could be torn down, so the truthful report is what the last good
    // sync left running — not 0, and not the coverage we failed to install.
    expect(stub.rules().length).toBe(live);
    expect(failed.registered).toBe(live);
    expect(failed.keywords).toBe(first.keywords);
    expect(failed.dropped).toBe(0);
    expect(failed.error).toMatch(/could not be removed/i);
    expect(failed.warning).toBeNull();
  });

  it('leaves the previous rules alone when the sync fails before the update', async () => {
    stub = installChromeStub({ state: state() });
    const first = await syncRules();
    const live = stub.rules().length;

    // A read failure never reached `updateDynamicRules`, so the installed rules
    // are untouched and still cover exactly what the last sync claimed.
    const dnr = (globalThis as unknown as { chrome: { declarativeNetRequest: Record<string, unknown> } })
      .chrome.declarativeNetRequest;
    const realGet = dnr.getDynamicRules;
    let calls = 0;
    dnr.getDynamicRules = async () => {
      calls += 1;
      if (calls === 1) throw new Error('Storage read failed.');
      return (realGet as () => Promise<chrome.declarativeNetRequest.Rule[]>)();
    };
    const failed = await syncRules();
    dnr.getDynamicRules = realGet;

    expect(stub.rules().length).toBe(live);
    expect(failed.keywords).toBe(first.keywords);
    expect(failed.error).toMatch(/Storage read failed/);
    expect(claim(stub.rules(), resultsUrl(SEARCH_ENGINES[0], 'gh+foo'))).toBe('redirect');
  });
});

/**
 * Chrome's RE2 budget is on the compiled program, so a shard that is fine in
 * Node can still be refused. `syncRules` halves a refused shard rather than
 * dropping it, and only that path can keep coverage whole.
 */
describe('a Chrome that refuses oversized patterns', () => {
  const LIMIT = 160;

  it('still intercepts every eligible alias, via splitting', async () => {
    const stored = state({ interceptEngines: ['google'] });
    const { status, rules } = await sync({
      state: stored,
      supports: (regex) => regex.length <= LIMIT,
    });

    const keywords = eligible(stored);
    expect(status.error).toBeNull();
    expect(status.keywords).toBe(keywords.length);
    expect(coverage(rules, keywords, enginesOf(['google'])).length).toBe(keywords.length);
    for (const rule of redirects(rules)) {
      expect((rule.condition.regexFilter as string).length).toBeLessThanOrEqual(LIMIT);
    }
  });
});

/**
 * The allow rule is what keeps BunnyLol's own marked searches out of its own
 * redirect rules; a redirect pattern matches them either way, because `blpass`
 * sits past the end of the captured `q` value. Registering redirects for an
 * engine whose allow rule Chrome refused is therefore an interception loop, and
 * failing closed is the only safe answer.
 */
describe('a Chrome that refuses the passthrough allow rule', () => {
  const supports = (regex: string) =>
    !(regex.includes(PASSTHROUGH_PARAM) && regex.includes('google'));

  it('registers no redirect rules for that engine and says so', async () => {
    const stored = state();
    const { status, rules } = await sync({ state: stored, supports });

    // Matched on the pattern's host prefix, not on the substring "google":
    // `google` is also an alias, and it appears in every engine's alternation.
    const google = enginesOf(['google'])[0];
    const onGoogle = (rule: chrome.declarativeNetRequest.Rule) =>
      (rule.condition.regexFilter as string).includes(google.host.replace(/\./g, '\\.'));
    expect(allows(rules).filter(onGoogle)).toEqual([]);
    expect(redirects(rules).filter(onGoogle)).toEqual([]);
    expect(allows(rules).length).toBe(SEARCH_ENGINES.length - 1);
    expect(redirects(rules).length).toBeGreaterThan(0);
    // A warning, not an error: the sync itself succeeded and the other two
    // engines are intercepting. `error` is reserved for "this did not work".
    expect(status.error).toBeNull();
    expect(status.warning).toMatch(/Google/);
    expect(status.warning).toMatch(new RegExp(PASSTHROUGH_PARAM));
  });

  it('leaves the loop url that used to bounce forever completely unclaimed', async () => {
    const { rules } = await sync({ state: state(), supports });
    // `weather boston` resolves to a marked google search, and the marker is
    // only safe while the allow rule outranks the redirect.
    const marked = resolve('weather boston', mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES), {
      ...DEFAULT_SETTINGS,
    }).url;
    expect(marked).toContain(`${PASSTHROUGH_PARAM}=1`);
    expect(claim(rules, marked)).toBeNull();
    expect(claim(rules, 'https://www.google.com/search?q=gh+foo')).toBeNull();
    // The escape hatch is intact for the same reason.
    expect(claim(rules, `https://www.google.com/search?q=gh%20foo&${PASSTHROUGH_PARAM}=1`)).toBeNull();
  });

  it('keeps intercepting the engines whose allow rule Chrome did accept', async () => {
    const { rules } = await sync({ state: state(), supports });
    const bing = enginesOf(['bing'])[0];
    expect(claim(rules, resultsUrl(bing, 'gh+foo'))).toBe('redirect');
    expect(claim(rules, `${resultsUrl(bing, 'gh+foo')}&${PASSTHROUGH_PARAM}=1`)).toBe('allow');
  });
});

describe('no engines selected', () => {
  it('is a choice, not a full rule budget', async () => {
    const { status, rules } = await sync({ state: state({ interceptEngines: [] }) });
    expect(rules).toEqual([]);
    expect(status.registered).toBe(0);
    expect(status.keywords).toBe(0);
    expect(status.dropped).toBe(0);
    expect(status.error).toBeNull();
    expect(status.warning).toBeNull();
  });
});

/**
 * The budget is chosen by rank — builtins first, shorter first — and only then
 * written longest-first into each alternation. Ranking by length alone truncated
 * from the hot end: 400 imported shortcuts used to cost the user `gh`.
 */
function synthetic(count: number): Command[] {
  return Array.from({ length: count }, (_, i) => ({
    keys: [`synthetic${i}`],
    name: `Synthetic ${i}`,
    description: '',
    url: `https://example.com/${i}`,
    searchUrl: `https://example.com/${i}?q={q}`,
    category: 'custom' as const,
    builtin: false,
  }));
}

describe('a profile with several hundred custom shortcuts', () => {
  const custom = synthetic(500);

  it('intercepts all of them AND every builtin — the caps have room', async () => {
    const stored = state({}, custom);
    const { status, rules } = await sync({ state: stored });

    const keywords = eligible(stored);
    expect(keywords.length).toBeGreaterThan(800);
    const covered = new Set(coverage(rules, keywords, SEARCH_ENGINES));
    expect(covered.size).toBe(keywords.length);
    expect(status.keywords).toBe(covered.size);
    expect(status.dropped).toBe(0);
    expect(status.error).toBeNull();
    expect(status.warning).toBeNull();
    expect(rules.length).toBeLessThanOrEqual(MAX_RULES);
  });
});

/**
 * Past the budget the tail is dropped, and WHICH tail is the point: an imported
 * profile large enough to overflow must not cost the user `gh`.
 */
describe('a profile far past the rule budget', () => {
  const custom = synthetic(3000);

  it('keeps every builtin alias and drops only custom ones', async () => {
    const stored = state({}, custom);
    const { status, rules } = await sync({ state: stored });

    const builtins = activeKeywords(BUILTIN_COMMANDS);
    expect(coverage(rules, builtins, SEARCH_ENGINES).length).toBe(builtins.length);
    expect(status.dropped).toBeGreaterThan(0);
    expect(status.keywords).toBeGreaterThan(builtins.length);
    expect(status.keywords + status.dropped).toBe(eligible(stored).length);
    expect(status.error).toBeNull();
    expect(status.warning).toMatch(/budget/);
    expect(rules.length).toBeLessThanOrEqual(MAX_RULES);
  });

  it('spends the overflow on keywords, never on the escape hatch', async () => {
    const { rules } = await sync({ state: state({}, custom) });
    expect(allows(rules).length).toBe(SEARCH_ENGINES.length);
    expect(escapeRulesOf(rules).length).toBe(SEARCH_ENGINES.length);
  });
});

/**
 * TRUE BUNNYLOL SEMANTICS end to end: the first word wins, and the escape hatch
 * is the way out. This is the behaviour a user feels, so it is asserted against
 * the rules `syncRules` actually registered rather than against `buildRules`.
 */
describe('the first word is always a command', () => {
  const commands = mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);

  it.each([
    ['map of france', 'https://www.google.com/maps'],
    ['news today', 'https://news.google.com'],
    ['stock market today', 'finance.yahoo.com'],
    ['office space movie', 'https://m365.cloud.microsoft'],
  ])('intercepts %j and routes it to the command', async (query, destination) => {
    const { rules } = await sync({ state: state() });
    const url = resultsUrl(SEARCH_ENGINES[0], query.replace(/ /g, '+'));
    expect(claim(rules, url)).toBe('redirect');
    expect(resolve(query, commands, { ...DEFAULT_SETTINGS }).url).toContain(destination);
  });

  it('leaves an exempted keyword alone, on every engine', async () => {
    const { rules } = await sync({ state: state({ interceptStopList: ['map', 'maps'] }) });
    for (const engine of SEARCH_ENGINES) {
      expect(claim(rules, resultsUrl(engine, 'map+of+france'))).toBeNull();
      // Only the exempted alias: its neighbours are still intercepted.
      expect(claim(rules, resultsUrl(engine, 'news+today'))).toBe('redirect');
    }
    // Exempted for interception only.
    expect(resolve('map of france', commands, { ...DEFAULT_SETTINGS }).fallback).toBe(false);
  });
});

/**
 * THE ESCAPE HATCH, against the registered rules. Every assertion here is
 * load-bearing: with nothing exempted by default, this is the only way to search
 * for a phrase whose first word is a shortcut.
 */
describe('the force-search escape hatch', () => {
  const commands = mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);

  /** What Chrome's address bar puts in `q=` for a query starting with `prefix`. */
  const encodedForms = (prefix: string): string[] => [
    `${encodeURIComponent(prefix)}gh+foo`,
    `${prefix}gh+foo`,
    `${encodeURIComponent(prefix)}gh%20foo`,
  ];

  it.each(FORCE_SEARCH_PREFIXES)('redirects an escaped query to go.html on every engine (%j)', async (prefix) => {
    const { rules } = await sync({ state: state() });
    for (const engine of SEARCH_ENGINES) {
      for (const value of encodedForms(prefix)) {
        const url = resultsUrl(engine, value);
        expect(claim(rules, url), `${engine.id} ${value}`).toBe('redirect');
        expect(redirectTo(rules, url)).toBe(`chrome-extension://${EXT_ID}/go.html?q=${value}`);
      }
    }
  });

  it.each(FORCE_SEARCH_PREFIXES)('resolves the redirected query to a plain marked search (%j)', async (prefix) => {
    const { rules } = await sync({ state: state() });
    const url = resultsUrl(SEARCH_ENGINES[0], `${encodeURIComponent(prefix)}gh+foo`);
    // Exactly what go.ts receives: the `q` of the url Chrome redirected to.
    const handed = new URL(
      (redirectTo(rules, url) as string).replace(/^chrome-extension:/, 'https:'),
    ).searchParams.get('q') as string;
    expect(handed).toBe(`${prefix}gh foo`);

    const result = resolve(handed, commands, { ...DEFAULT_SETTINGS });
    expect(result.fallback).toBe(true);
    expect(result.command).toBeNull();
    expect(result.url).toBe(`https://www.google.com/search?q=gh%20foo&${PASSTHROUGH_PARAM}=1`);
  });

  it.each(FORCE_SEARCH_PREFIXES)('never leaks the escape into the search terms (%j)', async (prefix) => {
    const { rules } = await sync({ state: state() });
    const url = resultsUrl(SEARCH_ENGINES[0], `${encodeURIComponent(prefix)}gh+foo`);
    const handed = new URL(
      (redirectTo(rules, url) as string).replace(/^chrome-extension:/, 'https:'),
    ).searchParams.get('q') as string;
    const searched = new URL(resolve(handed, commands, { ...DEFAULT_SETTINGS }).url).searchParams.get('q');
    expect(searched).toBe('gh foo');
    expect(searched).not.toContain(prefix);
    expect(searched).not.toContain(encodeURIComponent(prefix));
  });

  it.each(FORCE_SEARCH_PREFIXES)('does not loop: the resulting search is never redirected (%j)', async (prefix) => {
    const { rules } = await sync({ state: state() });
    const searched = resolve(`${prefix}gh foo`, commands, { ...DEFAULT_SETTINGS }).url;
    expect(claim(rules, searched)).toBe('allow');
    // Nothing in the escape family matches it either, marker or no marker.
    for (const rule of escapeRulesOf(rules)) {
      expect(new RegExp(rule.condition.regexFilter as string, 'i').test(searched)).toBe(false);
    }

    // A keyword rule still MATCHES `q=gh%20foo` — `blpass` sits past the end of
    // the captured value — and is only outranked. When the remainder is not a
    // keyword, literally no rule matches, which is the cleaner half of the same
    // guarantee.
    const plain = resolve(`${prefix}how tall is the eiffel tower`, commands, {
      ...DEFAULT_SETTINGS,
    }).url;
    expect(rules.filter((rule) => new RegExp(rule.condition.regexFilter as string, 'i').test(plain)))
      .toHaveLength(1);
    expect(claim(rules, plain)).toBe('allow');
  });

  it.each(FORCE_SEARCH_PREFIXES)('cannot be claimed by a keyword rule first (%j)', async (prefix) => {
    const { rules } = await sync({ state: state() });
    const url = resultsUrl(SEARCH_ENGINES[0], `${encodeURIComponent(prefix)}gh+foo`);
    const escapePriority = Math.max(
      ...escapeRulesOf(rules)
        .filter((rule) => new RegExp(rule.condition.regexFilter as string, 'i').test(url))
        .map((rule) => rule.priority as number),
    );
    for (const rule of keywordRulesOf(rules)) {
      expect(rule.priority as number).toBeLessThan(escapePriority);
    }
    // And in fact no keyword rule matches it at all: the value starts with the
    // escape, and no alias may contain `\`, `=` or `%`.
    const claimed = keywordRulesOf(rules).filter((rule) =>
      new RegExp(rule.condition.regexFilter as string, 'i').test(url),
    );
    expect(claimed).toEqual([]);
  });

  it('is registered even for a profile that overflows the rule budget', async () => {
    const { rules } = await sync({ state: state({}, synthetic(3000)) });
    const url = resultsUrl(SEARCH_ENGINES[0], '%5Cgh+foo');
    expect(claim(rules, url)).toBe('redirect');
  });
});
