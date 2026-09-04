/**
 * The rule path the extension actually runs.
 *
 * `background.ts` never calls `buildRules`; it calls `syncRules`, which plans
 * the same patterns but then validates every one against
 * `chrome.declarativeNetRequest.isRegexSupported`, splits what Chrome refuses,
 * fits the result into the rule budget and reports a `RuleStatus`. Everything
 * below drives that real function through a `chrome` stub and then asks what
 * the REGISTERED rules would do to a navigation: a status that claims coverage
 * the rules do not deliver is the failure mode these tests exist to catch.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { at } from './helpers/at';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { MAX_RULES, syncRules } from '../src/lib/dnr';
import { activeKeywords, mergeCommands, resolve } from '../src/lib/resolve';
import type {
  Command,
  RuleStatus,
  SearchEngine,
  SearchEngineId,
  StoredState,
} from '../src/lib/types';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  PASSTHROUGH_PARAM,
  STORAGE_KEY,
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

function state(
  overrides: Partial<StoredState['settings']> = {},
  custom: Command[] = [],
): StoredState {
  return {
    overrides: { ...DEFAULT_OVERRIDES, custom },
    settings: { ...DEFAULT_SETTINGS, ...overrides },
  };
}

async function sync(
  options: StubOptions,
): Promise<{ status: RuleStatus; rules: chrome.declarativeNetRequest.Rule[] }> {
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
});

/**
 * A REJECTED UPDATE LEAVES THE OLD RULES RUNNING.
 *
 * `updateDynamicRules` is atomic, so when it throws the previous dynamic rules
 * are still installed: the failure path used to assume the opposite and report
 * `keywords: 0`, while sixty obsolete redirect rules kept intercepting. Those
 * survivors are the redirect-loop condition on their own: they were built for
 * settings the user has since changed, and the options page was meanwhile
 * saying interception was off.
 */
describe('a Chrome that rejects the rule update', () => {
  /** Succeeds once, then refuses every later write, including the teardown. */
  const refuseAfterFirst = (call: number) => (call === 1 ? null : 'Dynamic rule quota exceeded.');

  it('removes the stale rules rather than leaving them live', async () => {
    stub = installChromeStub({
      state: state(),
      // The replacement is refused; the remove-only retry behind it is allowed.
      rejectUpdate: (call) => (call === 2 ? 'Dynamic rule quota exceeded.' : null),
    });
    const first = await syncRules();
    expect(first.keywords).toBeGreaterThan(150);
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
    // sync left running, not 0, and not the coverage we failed to install.
    expect(stub.rules().length).toBe(live);
    expect(failed.registered).toBe(live);
    expect(failed.keywords).toBe(first.keywords);
    expect(failed.dropped).toBe(0);
    expect(failed.error).toMatch(/could not be removed/i);
    expect(failed.warning).toBeNull();
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
    const google = at(enginesOf(['google']), 0);
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
    // `weather` was removed, so this now falls through to the default engine,
    // which is the same shape: a marked google search. The marker is only safe
    // while the allow rule outranks the redirect.
    const marked = resolve('weather boston', mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES), {
      ...DEFAULT_SETTINGS,
    }).url;
    expect(marked).toContain(`${PASSTHROUGH_PARAM}=1`);
    expect(claim(rules, marked)).toBeNull();
    expect(claim(rules, 'https://www.google.com/search?q=gh+foo')).toBeNull();
    // The escape hatch is intact for the same reason.
    expect(
      claim(rules, `https://www.google.com/search?q=gh%20foo&${PASSTHROUGH_PARAM}=1`),
    ).toBeNull();
  });
});

/**
 * The budget is chosen by rank: builtins first, shorter first. Only then is it
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
});

/**
 * TRUE BUNNYLOL SEMANTICS end to end: the first word wins, and the escape hatch
 * is the way out. This is the behaviour a user feels, so it is asserted against
 * the rules `syncRules` actually registered rather than against `buildRules`.
 */

/**
 * THE ESCAPE HATCH, against the registered rules. Every assertion here is
 * load-bearing: with nothing exempted by default, this is the only way to search
 * for a phrase whose first word is a shortcut.
 */
describe('the force-search escape hatch', () => {
  it('is registered even for a profile that overflows the rule budget', async () => {
    const { rules } = await sync({ state: state({}, synthetic(3000)) });
    const url = resultsUrl(at(SEARCH_ENGINES, 0), '%5Cgh+foo');
    expect(claim(rules, url)).toBe('redirect');
  });
});

/** Yields `count` times, so a caller can be made to arrive at a chosen
 *  microtask of a rebuild that is already running. */
async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
}

/**
 * How many microtasks a lone rebuild takes to settle against the stub. The
 * sweep below has to cover the whole of a run, and a hard-coded bound would
 * quietly stop reaching the end of one as the registry grows.
 */
async function ticksToSettle(): Promise<number> {
  stub?.restore();
  stub = installChromeStub({ strictIds: true, state: state() });
  let done = false;
  void syncRules().then(() => {
    done = true;
  });
  let count = 0;
  // Bounded so a rebuild that ever waits on a macrotask fails the test instead
  // of spinning forever.
  while (!done && count < 5000) {
    await Promise.resolve();
    count += 1;
  }
  expect(done).toBe(true);
  return count;
}

/**
 * A save is one `syncRules()` call, and onboarding writes several in a row.
 *
 * Rule ids are renumbered densely from the keyword count, so two overlapping
 * rebuilds read the same `existing` ids, both try to add the same ids, Chrome
 * refuses the second, and `failClosed` answers a refusal by tearing the whole
 * dynamic table down. `strictIds` is what makes the stub refuse the way Chrome
 * does; without it the collision is invisible and these tests pass vacuously.
 */
describe('concurrent syncs', () => {
  it('coalesces a burst of saves into at most two rule writes', async () => {
    stub = installChromeStub({ strictIds: true, state: state() });
    const results = await Promise.all([syncRules(), syncRules(), syncRules(), syncRules()]);

    expect(stub.updates).toBeLessThanOrEqual(2);
    for (const status of results) expect(status.error).toBeNull();
    // The three late callers share one trailing rebuild rather than queueing
    // three of their own.
    expect(results[2]).toBe(results[1]);
    expect(results[3]).toBe(results[1]);
    expect(results[0]).not.toBe(results[1]);
  });

  it('refuses an add whose id survives the removal, without changing the table', async () => {
    stub = installChromeStub({ strictIds: true, state: state() });
    await syncRules();
    const live = stub.rules().map((rule) => ({ ...rule }));

    await expect(
      chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ ...at(live, 0) }] }),
    ).rejects.toThrow(/already exists/);
    expect(stub.rules()).toEqual(live);
  });

  it('never starts a second rebuild while a coalesced follow-up is pending', async () => {
    // Derived, not hard-coded: the window sits at the end of a rebuild, so a
    // rebuild that grows longer must not push it past the end of the sweep.
    const span = await ticksToSettle();
    expect(span).toBeGreaterThan(8);

    for (let tick = 0; tick <= span + 8; tick += 1) {
      stub?.restore();
      stub = installChromeStub({ strictIds: true, state: state() });
      const burst = [syncRules(), syncRules()];
      const late = ticks(tick).then(async () => {
        // A save between the burst and the late caller: the two runs then plan
        // different id counts, which is what turns an overlap into a refusal.
        await chrome.storage.local.set({ [STORAGE_KEY]: state({}, synthetic(3)) });
        return syncRules();
      });

      for (const status of await Promise.all([...burst, late])) {
        expect(status.error, `arrival tick ${tick}`).toBeNull();
      }
      expect(stub.rules().length, `arrival tick ${tick}`).toBeGreaterThan(0);
    }
  });
});
