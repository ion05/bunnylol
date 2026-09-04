/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { buildRules, MAX_RULES } from '../src/lib/dnr';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { activeKeywords, mergeCommands, resolve } from '../src/lib/resolve';
import type { SearchEngine } from '../src/lib/types';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  DEFAULT_STOP_LIST,
  FORCE_SEARCH_PREFIXES,
} from '../src/lib/types';
import { at } from './helpers/at';
import { escapeRulesOf, keywordRulesOf, redirectTo as redirectToOf } from './helpers/rules';
import MANIFEST from '../public/manifest.json';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

const GOOGLE = SEARCH_ENGINES.find((engine) => engine.id === 'google') as SearchEngine;
const BING = SEARCH_ENGINES.find((engine) => engine.id === 'bing') as SearchEngine;
const DDG = SEARCH_ENGINES.find((engine) => engine.id === 'duckduckgo') as SearchEngine;

const KEYWORDS = ['gh', 'github', 'g', 'ghc', 'npm', 'lh'];

/** Chrome matches these case-insensitively (`isUrlFilterCaseSensitive: false`). */
function compile(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

/**
 * The keyword interception rules only. `buildRules` also emits passthrough allow
 * rules and force-search escape rules, and the escape rules are redirects too.
 */
function redirectRules(
  engines: SearchEngine[],
  keywords: string[] = KEYWORDS,
): chrome.declarativeNetRequest.Rule[] {
  return keywordRulesOf(buildRules(keywords, engines, EXT_ID));
}

function escapeRules(
  engines: SearchEngine[],
  keywords: string[] = KEYWORDS,
): chrome.declarativeNetRequest.Rule[] {
  return escapeRulesOf(buildRules(keywords, engines, EXT_ID));
}

function allowRules(
  engines: SearchEngine[],
  keywords: string[] = KEYWORDS,
): chrome.declarativeNetRequest.Rule[] {
  return buildRules(keywords, engines, EXT_ID).filter((rule) => rule.action.type === 'allow');
}

function filtersFor(engine: SearchEngine, keywords: string[] = KEYWORDS): string[] {
  return redirectRules([engine], keywords).map((rule) => rule.condition.regexFilter as string);
}

/** What Chrome would actually navigate to: the whole match is replaced. */
function redirectTo(
  url: string,
  engine: SearchEngine,
  keywords: string[] = KEYWORDS,
): string | null {
  for (const rule of redirectRules([engine], keywords)) {
    const pattern = compile(rule.condition.regexFilter as string);
    if (!pattern.test(url)) continue;
    const substitution = rule.action.redirect?.regexSubstitution as string;
    return url.replace(pattern, substitution.replace(/\\(\d)/g, '$$$1'));
  }
  return null;
}

/** The value the redirect would hand to go.html, or null when nothing matched. */
function capture(url: string, engine: SearchEngine, keywords: string[] = KEYWORDS): string | null {
  for (const pattern of filtersFor(engine, keywords)) {
    // The captured value, not the match: the group is not optional, so reading
    // it out is the same test as `if (match)`.
    const [, captured] = compile(pattern).exec(url) ?? [];
    if (captured !== undefined) return captured;
  }
  return null;
}

/**
 * A DNR redirect to an extension page is blocked outright unless the target is
 * web-accessible from the initiating origin, and it fails silently: the rule
 * registers, the navigation just never arrives. So the manifest and
 * `SEARCH_ENGINES` have to be kept in step, and nothing else checks that.
 */
describe('manifest support for the redirect target', () => {
  const wars = MANIFEST.web_accessible_resources;

  it('exposes go.html to every engine BunnyLol intercepts', () => {
    for (const engine of SEARCH_ENGINES) {
      const pattern = `https://${engine.host}/*`;
      const entry = wars.find(
        (war) => war.resources.includes('go.html') && war.matches.includes(pattern),
      );
      expect(entry, `go.html is not web-accessible from ${pattern}`).toBeDefined();
    }
  });

  it('holds a host permission for every engine', () => {
    for (const engine of SEARCH_ENGINES) {
      expect(MANIFEST.host_permissions).toContain(`https://${engine.host}/*`);
    }
  });

  it('declares the permissions the rules and the omnibox need', () => {
    expect(MANIFEST.permissions).toContain('declarativeNetRequest');
    expect(MANIFEST.permissions).toContain('storage');
    expect(MANIFEST.omnibox.keyword).toBe('bl');
  });

  /**
   * `tabs` gates the sensitive Tab fields (`url`, `title`, `pendingUrl`) and
   * costs a "read your browsing history" install warning. Creating and
   * navigating tabs needs no permission at all, and creating/navigating is the
   * whole of what BunnyLol does with them, so asking for it bought nothing but
   * the warning. `activeTab` is not a substitute: it grants host access on a
   * user gesture, which is a different and equally unneeded thing.
   */
  it('asks for no tab permission, because nothing reads a Tab property', () => {
    expect(MANIFEST.permissions).not.toContain('tabs');
    expect(MANIFEST.permissions).not.toContain('activeTab');

    const sources = import.meta.glob('../src/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    for (const source of Object.values(sources) as string[]) {
      // Every call site must be a create/update; a `tabs.query`, a `tabs.get`
      // or a read of `.url` off a Tab needs the permission back.
      for (const call of source.match(/chrome\.tabs\.\w+/g) ?? []) {
        expect(['chrome.tabs.create', 'chrome.tabs.update']).toContain(call);
      }
    }
  });
});

describe('buildRules', () => {
  it('captures the whole q value for a keyword plus arguments', () => {
    expect(capture('https://www.google.com/search?q=gh+facebook/react', GOOGLE)).toBe(
      'gh+facebook/react',
    );
    expect(capture('https://www.google.com/search?q=gh%20facebook%2Freact', GOOGLE)).toBe(
      'gh%20facebook%2Freact',
    );
  });

  it('does not fire on a query that merely starts with a keyword', () => {
    expect(capture('https://www.google.com/search?q=ghost+town', GOOGLE)).toBeNull();
    expect(capture('https://www.google.com/search?q=ghosts', GOOGLE)).toBeNull();
    expect(capture('https://www.google.com/search?q=npmjs+alternatives', GOOGLE)).toBeNull();
    expect(capture('https://www.google.com/search?q=github.com+status', GOOGLE)).toBeNull();
  });

  it('does not fire on a keyword prefix with the real builtin registry', () => {
    const real = activeKeywords(BUILTIN_COMMANDS);
    expect(capture('https://www.google.com/search?q=ghost+town', GOOGLE, real)).toBeNull();
    expect(capture('https://www.google.com/search?q=gh+facebook/react', GOOGLE, real)).toBe(
      'gh+facebook/react',
    );
  });

  it('matches a bare keyword with no arguments', () => {
    expect(capture('https://www.google.com/search?q=gh', GOOGLE)).toBe('gh');
    expect(capture('https://www.google.com/search?q=gh&oq=gh', GOOGLE)).toBe('gh');
    expect(capture('https://www.google.com/search?q=gh#frag', GOOGLE)).toBe('gh');
  });

  it('tolerates other parameters before q=', () => {
    expect(capture('https://www.google.com/search?client=firefox&hl=en&q=gh+react', GOOGLE)).toBe(
      'gh+react',
    );
    expect(
      capture('https://www.google.com/search?sourceid=chrome&ie=UTF-8&q=npm+zod&oq=x', GOOGLE),
    ).toBe('npm+zod');
  });

  it('stops the capture at the next parameter', () => {
    expect(capture('https://www.google.com/search?q=gh+react&sourceid=chrome', GOOGLE)).toBe(
      'gh+react',
    );
  });

  it('works for every shipped engine', () => {
    expect(capture('https://www.bing.com/search?q=gh+react', BING)).toBe('gh+react');
    expect(capture('https://duckduckgo.com/?q=gh+react', DDG)).toBe('gh+react');
    expect(capture('https://duckduckgo.com/?t=h_&q=gh+react', DDG)).toBe('gh+react');
  });

  it('ignores a different engine on the same rule', () => {
    expect(capture('https://www.bing.com/search?q=gh+react', GOOGLE)).toBeNull();
    expect(capture('https://example.com/search?q=gh+react', GOOGLE)).toBeNull();
    expect(capture('http://www.google.com/search?q=gh+react', GOOGLE)).toBeNull();
  });

  it('points regexSubstitution at go.html in this extension with the captured query', () => {
    const rules = redirectRules(SEARCH_ENGINES);
    for (const rule of rules) {
      expect(rule.action.type).toBe('redirect');
      expect(rule.action.redirect?.regexSubstitution).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=\\1`,
      );
      expect(rule.condition.resourceTypes).toEqual(['main_frame']);
      expect(rule.condition.isUrlFilterCaseSensitive).toBe(false);
      expect(rule.priority).toBeGreaterThan(0);
    }
  });

  it('gives every rule a unique id', () => {
    const rules = buildRules(KEYWORDS, SEARCH_ENGINES, EXT_ID);
    expect(redirectRules(SEARCH_ENGINES).length).toBe(SEARCH_ENGINES.length);
    expect(escapeRules(SEARCH_ENGINES).length).toBe(SEARCH_ENGINES.length);
    const ids = rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toBeGreaterThan(0);
  });

  it('regex-escapes keyword metacharacters', () => {
    const pattern = at(filtersFor(GOOGLE, ['c++', 'a.b', 'x|y', 'q?']), 0);
    expect(pattern).toContain('c\\+\\+');
    expect(pattern).toContain('a\\.b');
    expect(pattern).toContain('x\\|y');
    expect(() => compile(pattern)).not.toThrow();
    // The escaped `.` must not act as a wildcard.
    expect(capture('https://www.google.com/search?q=axb', GOOGLE, ['a.b'])).toBeNull();
    expect(capture('https://www.google.com/search?q=a.b+c', GOOGLE, ['a.b'])).toBe('a.b+c');
  });

  it('produces a compilable regex for the whole real registry', () => {
    const rules = buildRules(activeKeywords(BUILTIN_COMMANDS), SEARCH_ENGINES, EXT_ID);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(() => compile(rule.condition.regexFilter as string)).not.toThrow();
    }
  });

  it('returns nothing without an extension id, keywords or engines', () => {
    expect(buildRules(KEYWORDS, SEARCH_ENGINES, '')).toEqual([]);
    expect(buildRules([], SEARCH_ENGINES, EXT_ID)).toEqual([]);
    expect(buildRules(['   ', ''], SEARCH_ENGINES, EXT_ID)).toEqual([]);
    expect(buildRules(KEYWORDS, [], EXT_ID)).toEqual([]);
  });

  it('drops the parameters Chrome appends, instead of gluing them onto the query', () => {
    // The whole matched substring is replaced, so anything the match leaves
    // behind survives into the redirected url. Every real interception carries
    // these trailing params.
    expect(
      redirectTo(
        'https://www.google.com/search?q=gh+facebook%2Freact&sourceid=chrome&ie=UTF-8',
        GOOGLE,
      ),
    ).toBe(`chrome-extension://${EXT_ID}/go.html?q=gh+facebook%2Freact`);
    expect(redirectTo('https://www.bing.com/search?q=gh+react&PC=U316&FORM=CHROMN', BING)).toBe(
      `chrome-extension://${EXT_ID}/go.html?q=gh+react`,
    );
    expect(redirectTo('https://duckduckgo.com/?q=gh+react&t=hc', DDG)).toBe(
      `chrome-extension://${EXT_ID}/go.html?q=gh+react`,
    );
    expect(redirectTo('https://www.google.com/search?q=gh#frag', GOOGLE)).toBe(
      `chrome-extension://${EXT_ID}/go.html?q=gh`,
    );
  });

  it('never intercepts a search typed on the engine, only one typed in the address bar', () => {
    for (const rule of redirectRules(SEARCH_ENGINES)) {
      expect(rule.condition.excludedInitiatorDomains?.length).toBeGreaterThan(0);
    }
    const google = at(redirectRules([GOOGLE]), 0);
    expect(google.condition.excludedInitiatorDomains).toContain('www.google.com');
    expect(google.condition.excludedInitiatorDomains).toContain('google.com');
  });

  describe('passthrough allow rules', () => {
    const rules = allowRules(SEARCH_ENGINES);

    it('emits one per engine, outranking the redirects', () => {
      expect(rules.length).toBe(SEARCH_ENGINES.length);
      const redirectPriority = at(redirectRules(SEARCH_ENGINES), 0).priority as number;
      for (const rule of rules) {
        expect(rule.priority as number).toBeGreaterThan(redirectPriority);
      }
    });

    it('matches a BunnyLol-generated search and nothing else', () => {
      const google = at(rules, 0);
      const pattern = compile(google.condition.regexFilter as string);
      expect(pattern.test('https://www.google.com/search?q=gh%20foo&blpass=1')).toBe(true);
      expect(pattern.test('https://www.google.com/search?blpass=1&q=gh%20foo')).toBe(true);
      expect(pattern.test('https://www.google.com/search?q=gh%20foo')).toBe(false);
      expect(pattern.test('https://www.bing.com/search?q=gh%20foo&blpass=1')).toBe(false);
    });

    it('covers the same query the redirect rule would otherwise catch', () => {
      const url = 'https://www.google.com/search?q=gh%20foo&blpass=1';
      expect(redirectTo(url, GOOGLE)).not.toBeNull();
      expect(compile(at(allowRules([GOOGLE]), 0).condition.regexFilter as string).test(url)).toBe(
        true,
      );
    });
  });

  /**
   * The redirect substitution replaces the ENTIRE matched substring, so a rule
   * that stops matching too early leaks the engine's own parameters into the
   * query go.html resolves. Asserting the capture group alone cannot see that;
   * these assert the url Chrome would actually navigate to.
   */
  describe('the rewritten url', () => {
    it("is exactly go.html plus the query, for every engine's real trailing params", () => {
      expect(
        redirectTo(
          'https://www.google.com/search?q=gh+facebook%2Freact&sourceid=chrome&ie=UTF-8',
          GOOGLE,
        ),
      ).toBe(`chrome-extension://${EXT_ID}/go.html?q=gh+facebook%2Freact`);
      expect(
        redirectTo(
          'https://www.bing.com/search?q=gh+facebook%2Freact&qs=n&form=QBRE&sp=-1&pq=gh',
          BING,
        ),
      ).toBe(`chrome-extension://${EXT_ID}/go.html?q=gh+facebook%2Freact`);
      expect(redirectTo('https://duckduckgo.com/?q=gh+facebook%2Freact&t=h_&ia=web', DDG)).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=gh+facebook%2Freact`,
      );
    });

    it('drops a fragment instead of gluing it onto the query', () => {
      expect(redirectTo('https://www.google.com/search?q=gh+foo#top', GOOGLE)).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=gh+foo`,
      );
      expect(redirectTo('https://www.google.com/search?q=gh+foo&ie=UTF-8#top', GOOGLE)).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=gh+foo`,
      );
      expect(redirectTo('https://duckduckgo.com/?q=gh+foo&t=hc#r1-2', DDG)).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=gh+foo`,
      );
    });

    it('keeps parameters that sit before q= out of the query as well', () => {
      expect(
        redirectTo('https://www.google.com/search?client=chrome&q=npm+zod&sourceid=chrome', GOOGLE),
      ).toBe(`chrome-extension://${EXT_ID}/go.html?q=npm+zod`);
    });
  });

  /**
   * TRUE BUNNYLOL SEMANTICS. The first word wins: `new york times`, `r kelly`
   * and `help me write a resume` all reach the command, because the alternative,
   * a blocklist of English-looking aliases, was an endless tail. These
   * assertions are the inverse of the ones they replace, and that inversion is
   * the product decision, not a regression.
   */
  describe('with the shipped (empty) exemption list', () => {
    const intercepted = activeKeywords(BUILTIN_COMMANDS, DEFAULT_STOP_LIST);

    const ONCE_EXEMPT = [
      'new+york+times',
      'new%20york%20times',
      'r+kelly',
      'help+me+write+a+resume',
      'add+to+cart',
      'w+hotel+chicago',
      'map+of+france',
      'word+for+happy',
      'x+ray',
    ];

    it('ships no exemptions at all', () => {
      expect(DEFAULT_STOP_LIST).toEqual([]);
    });

    it.each(ONCE_EXEMPT)('intercepts a google search for %s', (query) => {
      const url = `https://www.google.com/search?q=${query}&sourceid=chrome&ie=UTF-8`;
      expect(redirectTo(url, GOOGLE, intercepted)).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=${query}`,
      );
    });

    it('covers every builtin alias: nothing is dropped', () => {
      const covered = new Set<string>();
      for (const rule of redirectRules(SEARCH_ENGINES, intercepted)) {
        const [, alternation] =
          /\(\(\?:(.*?)\)\(\?:\(\?:%20/.exec(rule.condition.regexFilter as string) ?? [];
        if (alternation === undefined) continue;
        for (const alias of alternation.split('|')) covered.add(alias.replace(/\\/g, ''));
      }
      expect(intercepted.length).toBeGreaterThan(150);
      expect(intercepted.filter((alias) => !covered.has(alias))).toEqual([]);
    });
  });

  /**
   * A user who exempts a keyword gets the old behaviour for that one keyword,
   * and only in the address bar.
   */
  describe('a keyword the user exempted', () => {
    const exempted = activeKeywords(BUILTIN_COMMANDS, ['maps', 'map']);

    it('gets no rule, on any engine', () => {
      for (const engine of SEARCH_ENGINES) {
        const url = `https://${engine.host}/search?q=maps+of+france`;
        expect(capture(url, engine, exempted)).toBeNull();
      }
      expect(exempted).not.toContain('maps');
      expect(exempted).not.toContain('map');
      expect(exempted).toContain('gh');
    });

    it('still resolves through the omnibox and the popup', () => {
      const commands = mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);
      for (const alias of ['maps', 'map']) {
        const result = resolve(`${alias} thing`, commands, { ...DEFAULT_SETTINGS });
        expect(result.fallback, `${alias} fell through to the search engine`).toBe(false);
        expect(result.command?.keys).toContain(alias);
      }
    });
  });

  /**
   * THE ESCAPE HATCH. With every keyword intercepted this is the only way to
   * search for a phrase whose first word is a shortcut, so it has to work from
   * the address bar, where Chrome percent-encodes what the user typed.
   */
  describe('force-search escape rules', () => {
    const real = activeKeywords(BUILTIN_COMMANDS, DEFAULT_STOP_LIST);
    const rules = escapeRules(SEARCH_ENGINES, real);

    it('emits one per engine, outranking the keyword rules', () => {
      expect(rules.length).toBe(SEARCH_ENGINES.length);
      const keywordPriority = Math.max(
        ...redirectRules(SEARCH_ENGINES, real).map((rule) => rule.priority as number),
      );
      for (const rule of rules) expect(rule.priority as number).toBeGreaterThan(keywordPriority);
    });

    it('is outranked in turn by the passthrough allow rules', () => {
      const lowestAllow = Math.min(
        ...allowRules(SEARCH_ENGINES, real).map((rule) => rule.priority as number),
      );
      for (const rule of rules) expect(lowestAllow).toBeGreaterThan(rule.priority as number);
    });

    it.each(SEARCH_ENGINES)('matches both escape forms, raw and encoded, on $id', (engine) => {
      const rule = at(escapeRules([engine], real), 0);
      const pattern = compile(rule.condition.regexFilter as string);
      const path = engine.id === 'duckduckgo' ? '/' : '/search';
      for (const value of ['%5Cgh+foo', '\\gh+foo', '=gh+foo', '%3Dgh+foo', '%5C+gh+foo']) {
        expect(pattern.test(`https://${engine.host}${path}?q=${value}`), value).toBe(true);
      }
      // Only at the START of the value: `2+=+2` is arithmetic, not an escape.
      expect(pattern.test(`https://${engine.host}${path}?q=2+%3D+2`)).toBe(false);
      expect(pattern.test(`https://${engine.host}${path}?q=gh+foo`)).toBe(false);
    });

    it('redirects to go.html with the escape character intact', () => {
      // go.ts hands the value straight to `resolve()`, which is the one place
      // that knows how to strip a prefix: the rule must not eat it here.
      // Against the WHOLE rule set, so this also proves a keyword rule cannot
      // claim the query first: `redirectToOf` applies the highest priority.
      const all = buildRules(real, SEARCH_ENGINES, EXT_ID);
      expect(redirectToOf(all, 'https://www.google.com/search?q=%5Cgh+foo&ie=UTF-8')).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=%5Cgh+foo`,
      );
      expect(redirectToOf(all, 'https://www.bing.com/search?q=%3Dgh+foo&FORM=CHROMN')).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=%3Dgh+foo`,
      );
      expect(redirectToOf(all, 'https://duckduckgo.com/?q=%5Cgh+foo&t=hc')).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=%5Cgh+foo`,
      );
    });

    it('covers every prefix the resolver honours', () => {
      const rule = at(escapeRules([GOOGLE], real), 0);
      const pattern = rule.condition.regexFilter as string;
      for (const prefix of FORCE_SEARCH_PREFIXES) {
        expect(pattern, prefix).toContain(encodeURIComponent(prefix));
      }
    });

    it("never intercepts an escape typed into the engine's own search box", () => {
      for (const rule of rules) {
        expect(rule.condition.excludedInitiatorDomains?.length).toBeGreaterThan(0);
      }
    });
  });

  /**
   * The escape hatch resolves to a plain search whose url our own keyword rules
   * would otherwise match, bouncing the user straight back into the command
   * they were escaping. The passthrough marker plus the higher-priority allow
   * rule is what breaks that loop.
   */
  describe('the force-search round trip', () => {
    const commands = mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);
    const real = activeKeywords(BUILTIN_COMMANDS, DEFAULT_STOP_LIST);

    it.each(FORCE_SEARCH_PREFIXES)('resolves %j to a marked search of the remainder', (prefix) => {
      const forced = resolve(`${prefix}gh foo`, commands, { ...DEFAULT_SETTINGS });
      expect(forced.fallback).toBe(true);
      expect(forced.url).toBe('https://www.google.com/search?q=gh%20foo&blpass=1');
      // The prefix must never survive into what the engine searches for.
      expect(forced.url).not.toContain(encodeURIComponent(prefix));
      expect(forced.args).toBe('gh foo');
    });

    it('is claimed by the allow rule, which outranks every other rule', () => {
      const forced = resolve('=gh foo', commands, { ...DEFAULT_SETTINGS });
      const allow = at(allowRules([GOOGLE], real), 0);
      expect(compile(allow.condition.regexFilter as string).test(forced.url)).toBe(true);
      for (const rule of [
        ...redirectRules(SEARCH_ENGINES, real),
        ...escapeRules(SEARCH_ENGINES, real),
      ]) {
        expect(allow.priority as number).toBeGreaterThan(rule.priority as number);
      }
    });

    it('would otherwise have been redirected, which is why the allow rule exists', () => {
      // Without the marker the same search is caught by our own rule.
      expect(redirectTo('https://www.google.com/search?q=gh%20foo', GOOGLE, real)).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=gh%20foo`,
      );
    });
  });

  it('excludes the engine as an initiator on every redirect rule, for every engine', () => {
    const rules = redirectRules(
      SEARCH_ENGINES,
      activeKeywords(BUILTIN_COMMANDS, DEFAULT_STOP_LIST),
    );
    // The real registry shards, so this is several rules per engine.
    expect(rules.length).toBeGreaterThanOrEqual(SEARCH_ENGINES.length);
    expect(rules.length % SEARCH_ENGINES.length).toBe(0);
    for (const rule of rules) {
      const excluded = rule.condition.excludedInitiatorDomains ?? [];
      expect(excluded.length).toBeGreaterThan(0);
      // The naked registrable domain has to be there too: Chrome reports the
      // initiator of a search started on google.com as `google.com`.
      const engine = SEARCH_ENGINES.find((candidate) =>
        (rule.condition.regexFilter as string).includes(candidate.host.replace(/\./g, '\\.')),
      );
      expect(engine).toBeDefined();
      expect(excluded).toContain(engine!.host);
      expect(excluded).toContain(engine!.host.replace(/^www\./, ''));
    }
  });

  describe('sharding', () => {
    const many = Array.from({ length: 500 }, (_, i) => `key${i}`);
    const rules = buildRules(many, SEARCH_ENGINES, EXT_ID);

    it('splits the alternation across several rules per engine', () => {
      const perEngine = redirectRules(SEARCH_ENGINES, many).length / SEARCH_ENGINES.length;
      expect(perEngine).toBeGreaterThan(1);
      expect(Number.isInteger(perEngine)).toBe(true);
    });

    it('keeps every rule well under the 2KB regex budget', () => {
      for (const rule of rules) {
        const pattern = rule.condition.regexFilter as string;
        expect(pattern.length).toBeLessThan(2048);
        expect(() => compile(pattern)).not.toThrow();
      }
    });

    it('still gives every shard a unique id', () => {
      const ids = rules.map((rule) => rule.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('still intercepts a keyword from a late shard', () => {
      const captured = capture('https://www.google.com/search?q=key499+hello', GOOGLE, many);
      expect(captured).toBe('key499+hello');
    });

    it('caps the rule count rather than blowing the dynamic-rule quota', () => {
      const absurd = Array.from({ length: 20000 }, (_, i) => `synthetickeyword${i}`);
      const capped = buildRules(absurd, SEARCH_ENGINES, EXT_ID);
      expect(capped.length).toBeLessThanOrEqual(MAX_RULES);
      expect(new Set(capped.map((rule) => rule.id)).size).toBe(capped.length);
      for (const rule of capped) {
        expect((rule.condition.regexFilter as string).length).toBeLessThan(2048);
      }
    });
  });
});
