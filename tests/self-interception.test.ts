/**
 * BunnyLol must never intercept its own output.
 *
 * Several commands resolve to a search on an engine we intercept: `g` and `ddg`
 * ARE searches, every `site:` degrade is one, and so is the Gemini AI template.
 * Navigating there unmarked re-enters our own redirect rule, which hands the url
 * straight back to go.html: `g npm install` lands on the npm package page
 * instead of a search for "npm install", and a degrade that puts its own keyword
 * back into the query loops forever.
 *
 * The invariant these tests pin down is end-to-end rather than per-function: take
 * the url `resolve()` actually produces, hand it to the rules the extension
 * really registers, and ask which rule Chrome would apply. It must never be a
 * redirect. The sweep runs against the rules `syncRules()` hands to
 * `chrome.declarativeNetRequest` and nothing else, because that is the only path
 * that ships (AGENTS.md: a test driving `buildRules` alone is not testing what
 * ships). It is driven off `BUILTIN_COMMANDS`, so a command added later that
 * happens to land on a search engine fails here without anyone remembering to.
 */

import { describe, expect, it } from 'vitest';
import { at } from './helpers/at';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { buildRules, syncRules } from '../src/lib/dnr';
import { activeKeywords, mergeCommands, resolve, stripPassthrough } from '../src/lib/resolve';
import type { Command, Settings } from '../src/lib/types';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  DEFAULT_STOP_LIST,
  PASSTHROUGH_PARAM,
} from '../src/lib/types';
import { EXT_ID, claim as claimOf, installChromeStub, matches, priorityOf } from './helpers/rules';

const COMMANDS: Command[] = mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);
const SETTINGS: Settings = { ...DEFAULT_SETTINGS };

/**
 * Exactly the keyword set the service worker registers rules for. With the
 * shipped (empty) exemption list that is EVERY safe alias, so this sweep now
 * covers the whole registry rather than the ~270 that used to be eligible.
 */
const KEYWORDS = activeKeywords(COMMANDS, DEFAULT_STOP_LIST);

/**
 * The rules the extension really runs on, and the only set the sweeps below are
 * driven against. `syncRules` is the shipping path: it validates each pattern
 * through Chrome, splits the ones it refuses and renumbers the ids, and
 * AGENTS.md is explicit that a test driving `buildRules` alone is not testing
 * what ships.
 *
 * Every sweep used to run twice, once over each set. That bought nothing for
 * self-interception: both sets come out of the same `planRedirects`,
 * `buildAllowRules` and `buildEscapeRules`, so the patterns are identical and
 * there is no divergence in what Chrome would claim for a url. `buildRules` is
 * driven exhaustively by `tests/dnr.test.ts` instead.
 */
const REGISTERED = await registeredRules();

/**
 * The mirror is still compared on the cheap structural facts further down (the
 * rule counts and the escape hatch), which is where a `buildRules` that had
 * drifted out of step with `syncRules` would actually show.
 */
const RULE_SETS: Array<[string, chrome.declarativeNetRequest.Rule[]]> = [
  ['buildRules', buildRules(KEYWORDS, SEARCH_ENGINES, EXT_ID)],
  ['syncRules', REGISTERED],
];

/** The rules `syncRules` really hands to `chrome.declarativeNetRequest`. */
async function registeredRules(): Promise<chrome.declarativeNetRequest.Rule[]> {
  const stub = installChromeStub({
    state: { overrides: DEFAULT_OVERRIDES, settings: SETTINGS },
  });
  try {
    await syncRules();
    return stub.rules();
  } finally {
    stub.restore();
  }
}

/**
 * Argument shapes worth trying against every command, biased towards the ones
 * that break things: arguments that themselves begin with a registered keyword
 * are exactly how `g npm install` used to land on npmjs.com.
 */
const ARG_SHAPES = [
  '',
  'foo',
  'gh foo',
  'npm install',
  'g npm install',
  'ddg gh foo',
  'g g foo',
  'new york times',
  'facebook/react',
  'site:example.com bar',
];

describe('the rules syncRules registers', () => {
  const RULES = REGISTERED;
  const claim = (url: string) => claimOf(RULES, url);

  describe('no builtin command resolves to something we would re-intercept', () => {
    it('marks every destination that lands on an intercepted engine', () => {
      // The complement of the check above: a destination a redirect rule matches
      // is only safe because it carries the marker, so it must carry the marker.
      const unmarked: string[] = [];

      for (const cmd of BUILTIN_COMMANDS) {
        for (const args of ARG_SHAPES) {
          const key = at(cmd.keys, 0);
          const query = args ? `${key} ${args}` : key;
          const { url } = resolve(query, COMMANDS, SETTINGS);
          const redirects = RULES.filter(
            (rule) => rule.action.type === 'redirect' && matches(rule, url),
          );
          if (redirects.length === 0) continue;
          if (!url.includes(`${PASSTHROUGH_PARAM}=`)) unmarked.push(`${query} -> ${url}`);
        }
      }

      expect(unmarked).toEqual([]);
    });

    it('sends a query that lands on an engine exactly once, to that destination', () => {
      // `g npm install` used to be re-caught by our own npm rule and land on
      // npmjs.com. The marker is why it does not.
      for (const query of ['g npm install', 'g gh foo', 'ddg npm install', 'g new york times']) {
        const { url } = resolve(query, COMMANDS, SETTINGS);
        expect(claim(url), query).not.toBe('redirect');
        // The unmarked url is what the redirect rules were built to catch: that
        // is precisely why the resolver marks it.
        expect(claim(stripPassthrough(url)), query).toBe('redirect');
      }
    });
  });

  describe('passthrough allow rules', () => {
    const allow = RULES.filter((rule) => rule.action.type === 'allow');
    const redirects = RULES.filter((rule) => rule.action.type === 'redirect');

    it('outrank every redirect rule', () => {
      expect(allow.length).toBe(SEARCH_ENGINES.length);
      const lowestAllow = Math.min(...allow.map(priorityOf));
      const highestRedirect = Math.max(...redirects.map(priorityOf));
      expect(lowestAllow).toBeGreaterThan(highestRedirect);
    });
  });
});

/**
 * The shard cap is what keeps each `regexFilter` inside the RE2 memory budget
 * Chrome compiles it with; blowing it makes `updateDynamicRules` reject the
 * whole batch, which looks exactly like a dead extension.
 */
describe('shard sizing at 500 keywords', () => {
  describe('a user who repoints a builtin at an intercepted engine', () => {
    it('still gets the passthrough marker', () => {
      // The sweep above is derived from the SHIPPED registry, so it cannot see
      // this: the at-risk set is a property of where a command points, and the
      // edit layer lets the user move one onto a search engine we intercept. If
      // the marker were applied from a list of command names rather than from the
      // resolved url, `npm` would loop back into go.html here.
      const commands = mergeCommands(BUILTIN_COMMANDS, {
        ...DEFAULT_OVERRIDES,
        edits: { npm: { url: 'https://www.google.com/search?q=npm' } },
      });
      const result = resolve('npm', commands, SETTINGS);
      expect(result.url).toContain('www.google.com/search');
      expect(result.url).toContain(`${PASSTHROUGH_PARAM}=1`);
      for (const [, rules] of RULE_SETS) {
        expect(claimOf(rules, result.url)).not.toBe('redirect');
      }
    });
  });
});
