/**
 * BunnyLol must never intercept its own output.
 *
 * Several commands resolve to a search on an engine we intercept — `weather` IS
 * a google search, and so are `g`, `gimg`, `gvid`, `gbooks`, `ddg`, `bing`, the
 * `gsite` handler and the Gemini AI template. Navigating there unmarked re-enters
 * our own redirect rule, which hands the url straight back to go.html: `weather`
 * loops forever and `g npm install` lands on the npm package page instead of a
 * search for "npm install".
 *
 * The invariant these tests pin down is end-to-end rather than per-function: take
 * the url `resolve()` actually produces, hand it to the rules the extension
 * really registers, and ask which rule Chrome would apply. It must never be a
 * redirect. Every sweep runs against both `buildRules()` and the rules
 * `syncRules()` hands to `chrome.declarativeNetRequest`, and is driven off
 * `BUILTIN_COMMANDS`, so a command added later that happens to land on a search
 * engine fails here without anyone remembering to.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { buildRules, MAX_ALTERNATION_CHARS, MAX_RULES, syncRules } from '../src/lib/dnr';
import { activeKeywords, mergeCommands, resolve, stripPassthrough } from '../src/lib/resolve';
import type { Command, Settings } from '../src/lib/types';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  DEFAULT_STOP_LIST,
  FORCE_SEARCH_PREFIXES,
  PASSTHROUGH_PARAM,
} from '../src/lib/types';
import {
  EXT_ID,
  claim as claimOf,
  installChromeStub,
  isEscapeRule,
  keywordRulesOf,
  matches,
  priorityOf,
  redirectTo as redirectToOf,
} from './helpers/rules';

const COMMANDS: Command[] = mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);
const SETTINGS: Settings = { ...DEFAULT_SETTINGS };

/**
 * Exactly the keyword set the service worker registers rules for. With the
 * shipped (empty) exemption list that is EVERY safe alias, so this sweep now
 * covers the whole registry rather than the ~270 that used to be eligible.
 */
const KEYWORDS = activeKeywords(COMMANDS, DEFAULT_STOP_LIST);

/**
 * Every invariant below is checked against BOTH rule sets, because they are
 * different code paths: the extension only ever runs `syncRules`, which
 * validates each pattern through Chrome, splits the ones it refuses and
 * renumbers the ids, while `buildRules` is the pure mirror the rest of this
 * suite reasons about. A self-interception guarantee that holds for one of them
 * and not the other is not a guarantee.
 */
const RULE_SETS: Array<[string, chrome.declarativeNetRequest.Rule[]]> = [
  ['buildRules', buildRules(KEYWORDS, SEARCH_ENGINES, EXT_ID)],
  ['syncRules', await registeredRules()],
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

/** What go.html would resolve, given a url the redirect rules produced. */
function queryHandedToGo(goUrl: string): string {
  const query = new URL(goUrl.replace(/^chrome-extension:/, 'https:')).searchParams.get('q') ?? '';
  return stripPassthrough(query);
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
  'weather boston',
  'ddg gh foo',
  'new york times',
  'facebook/react',
  'site:example.com bar',
];

describe.each(RULE_SETS)('the rules %s produces', (_label, RULES) => {
  const claim = (url: string) => claimOf(RULES, url);
  const redirectTo = (url: string) => redirectToOf(RULES, url);

  describe('no builtin command resolves to something we would re-intercept', () => {
    it.each(ARG_SHAPES)('for arguments %j', (args) => {
      const offenders: string[] = [];

      for (const cmd of BUILTIN_COMMANDS) {
        for (const alias of cmd.keys) {
          const query = args ? `${alias} ${args}` : alias;
          const { url } = resolve(query, COMMANDS, SETTINGS);
          if (claim(url) === 'redirect') {
            offenders.push(`${cmd.name}: "${query}" -> ${url} -> ${redirectTo(url)}`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    it('marks every destination that lands on an intercepted engine', () => {
      // The complement of the check above: a destination a redirect rule matches
      // is only safe because it carries the marker, so it must carry the marker.
      const unmarked: string[] = [];

      for (const cmd of BUILTIN_COMMANDS) {
        for (const args of ARG_SHAPES) {
          const query = args ? `${cmd.keys[0]} ${args}` : cmd.keys[0];
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

    it('leaves the fallback search alone as well', () => {
      // Not a command at all: an unrecognized query, and every escape prefix.
      const escaped = FORCE_SEARCH_PREFIXES.flatMap((prefix) => [
        `${prefix}gh foo`,
        `${prefix}weather boston`,
        `${prefix}maps of france`,
      ]);
      for (const query of ['ghost town', 'how to tie a tie', ...escaped]) {
        const { url } = resolve(query, COMMANDS, SETTINGS);
        expect(claim(url), `${query} -> ${url}`).not.toBe('redirect');
      }
    });

    /**
     * The other half of the escape hatch: what the ESCAPE RULE hands go.html has
     * to resolve to a search that this same rule set will not claim again. A
     * loop here is unescapable without closing the tab.
     */
    it.each(FORCE_SEARCH_PREFIXES)('round-trips an escaped query typed in the address bar (%j)', (prefix) => {
      const typed = `https://www.google.com/search?q=${encodeURIComponent(prefix)}gh+foo&ie=UTF-8`;
      expect(claim(typed)).toBe('redirect');
      const handed = queryHandedToGo(redirectTo(typed) as string).replace(/\+/g, ' ');
      expect(handed).toBe(`${prefix}gh foo`);

      const { url, fallback } = resolve(handed, COMMANDS, SETTINGS);
      expect(fallback).toBe(true);
      expect(claim(url)).toBe('allow');
      expect(new URL(url).searchParams.get('q')).toBe('gh foo');
    });

    // Every one of these resolves to a search whose `q` value starts with a
    // registered keyword, which is the shape that used to loop or misroute.
    it.each(['g npm install', 'gimg gh foo', 'weather boston', 'ddg gh foo', 'bing gh foo'])(
      'sends %j exactly once, to the destination the resolver picked',
      (query) => {
        const { url } = resolve(query, COMMANDS, SETTINGS);
        expect(claim(url)).not.toBe('redirect');
        // The unmarked url is what the redirect rules were built to catch — that
        // is precisely why the resolver marks it.
        expect(claim(stripPassthrough(url))).toBe('redirect');
      },
    );
  });

  /**
   * `weather` is the worst case: its destination is a google search whose `q`
   * value literally starts with the keyword, so an unmarked one is redirected to
   * go.html, resolved to the same url, redirected again — a navigation loop the
   * user cannot escape without closing the tab.
   */
  describe('weather does not reproduce itself', () => {
    const bare = resolve('weather', COMMANDS, SETTINGS).url;
    const located = resolve('weather boston', COMMANDS, SETTINGS).url;

    it('resolves to a marked google search', () => {
      expect(bare).toBe('https://www.google.com/search?q=weather&blpass=1');
      expect(located).toBe('https://www.google.com/search?q=weather+boston&blpass=1');
    });

    it('is not redirected back into the dispatch page', () => {
      expect(claim(bare)).toBe('allow');
      expect(claim(located)).toBe('allow');
      expect(redirectTo(bare)).not.toBeNull(); // matched, but outranked
    });

    it('reaches a fixpoint-free end state: resolving it again changes nothing', () => {
      // Even if a stale rule from an older build did bounce it, go.html strips the
      // marker and re-resolves to the same place rather than to a different
      // command, so the loop is broken at both ends.
      const bounced = redirectTo(stripPassthrough(located)) as string;
      const requery = queryHandedToGo(bounced).replace(/\+/g, ' ');
      expect(requery).toBe('weather boston');
      expect(resolve(requery, COMMANDS, SETTINGS).url).toBe(located);
      expect(claim(resolve(requery, COMMANDS, SETTINGS).url)).toBe('allow');
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

    it.each(SEARCH_ENGINES)('claims any marked url on $id', (engine) => {
      const base = engine.id === 'duckduckgo' ? `https://${engine.host}/` : `https://${engine.host}/search`;
      const urls = [
        `${base}?q=gh+foo&${PASSTHROUGH_PARAM}=1`,
        `${base}?${PASSTHROUGH_PARAM}=1&q=gh+foo`,
        `${base}?q=gh+foo&${PASSTHROUGH_PARAM}=1&ie=UTF-8`,
        `${base}?q=gh+foo&${PASSTHROUGH_PARAM}=1#top`,
        // Chrome matches case-insensitively, and so must the marker.
        `${base}?q=gh+foo&${PASSTHROUGH_PARAM.toUpperCase()}=1`,
      ];
      for (const url of urls) expect(claim(url), url).toBe('allow');
    });

    it('claims nothing that is not marked', () => {
      expect(claim('https://www.google.com/search?q=gh+foo')).toBe('redirect');
      expect(claim('https://www.google.com/search?q=ghost+town')).toBeNull();
      // Another site's url with the marker on it is none of our business.
      expect(claim(`https://example.com/search?q=gh+foo&${PASSTHROUGH_PARAM}=1`)).toBeNull();
    });
  });
});

/**
 * The shard cap is what keeps each `regexFilter` inside the RE2 memory budget
 * Chrome compiles it with; blowing it makes `updateDynamicRules` reject the
 * whole batch, which looks exactly like a dead extension.
 */
describe('shard sizing at 500 keywords', () => {
  const many = Array.from({ length: 500 }, (_, i) => `synthetic${i}`);
  const rules = buildRules(many, SEARCH_ENGINES, EXT_ID);

  it('keeps every alternation under the documented cap', () => {
    // Keyword rules only: the allow rules hold no alternation, and the escape
    // rules hold a fixed two-character one that is not budgeted.
    for (const rule of keywordRulesOf(rules)) {
      const pattern = rule.condition.regexFilter as string;
      const alternation = /\(\(\?:(.*?)\)\(\?:/.exec(pattern)?.[1];
      if (!alternation) continue;
      expect(alternation.length, pattern).toBeLessThanOrEqual(MAX_ALTERNATION_CHARS);
    }
  });

  it('registers the escape hatch for every engine, in both rule sets', () => {
    for (const [, set] of RULE_SETS) {
      expect(set.filter(isEscapeRule).length).toBe(SEARCH_ENGINES.length);
    }
  });

  it('emits only patterns a regex engine will compile', () => {
    expect(rules.length).toBeGreaterThan(SEARCH_ENGINES.length);
    for (const rule of rules) {
      const pattern = rule.condition.regexFilter as string;
      expect(() => new RegExp(pattern)).not.toThrow();
      // Chrome's RE2 budget is on the compiled program; the source length is
      // only a proxy, but a pattern near 2KB of source never fits.
      expect(pattern.length).toBeLessThan(2048);
    }
  });

  it('stays inside the dynamic-rule and regex-rule quotas', () => {
    expect(rules.length).toBeLessThanOrEqual(MAX_RULES);
    // chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES / _DYNAMIC_RULES.
    expect(MAX_RULES).toBeLessThan(1000);
    expect(MAX_RULES).toBeLessThan(5000);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
  });

  it.each(RULE_SETS)('still covers the real registry without exhausting the budget (%s)', (_label, real) => {
    expect(real.length).toBeLessThanOrEqual(MAX_RULES);
    expect(real.length).toBeGreaterThan(SEARCH_ENGINES.length);
  });
});
