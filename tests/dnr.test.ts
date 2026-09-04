/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { buildRules } from '../src/lib/dnr';
import { SEARCH_ENGINES } from '../src/lib/commands';
import type { SearchEngine } from '../src/lib/types';
import { at } from './helpers/at';
import { escapeRulesOf, keywordRulesOf, redirectTo as redirectToOf } from './helpers/rules';

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

  it('works for every shipped engine', () => {
    expect(capture('https://www.bing.com/search?q=gh+react', BING)).toBe('gh+react');
    expect(capture('https://duckduckgo.com/?q=gh+react', DDG)).toBe('gh+react');
    expect(capture('https://duckduckgo.com/?t=h_&q=gh+react', DDG)).toBe('gh+react');
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

    it('covers the same query the redirect rule would otherwise catch', () => {
      const url = 'https://www.google.com/search?q=gh%20foo&blpass=1';
      expect(redirectTo(url, GOOGLE)).not.toBeNull();
      expect(compile(at(allowRules([GOOGLE]), 0).condition.regexFilter as string).test(url)).toBe(
        true,
      );
    });
  });
  /**
   * THE ESCAPE HATCH. With every keyword intercepted this is the only way to
   * search for a phrase whose first word is a shortcut, so it has to work from
   * the address bar, where Chrome percent-encodes what the user typed.
   *
   * Invariant 2: the priority ladder is redirect (1) < escape (2) < allow (3).
   * An escape rule that does not outrank the keyword rules leaves the user in a
   * redirect loop with no way out.
   */
  describe('force-search escape rules', () => {
    const all = buildRules(KEYWORDS, SEARCH_ENGINES, EXT_ID);
    const escapes = escapeRulesOf(all);

    it('sits between the keyword redirects and the allow rules, one per engine', () => {
      expect(escapes.length).toBe(SEARCH_ENGINES.length);
      const keywordPriority = Math.max(
        ...keywordRulesOf(all).map((rule) => rule.priority as number),
      );
      const lowestAllow = Math.min(...allowRules(SEARCH_ENGINES).map((r) => r.priority as number));
      for (const rule of escapes) {
        expect(rule.priority as number).toBeGreaterThan(keywordPriority);
        expect(lowestAllow).toBeGreaterThan(rule.priority as number);
      }
    });

    it('redirects to go.html with the escape character intact', () => {
      // go.ts hands the value straight to `resolve()`, which is the one place
      // that knows how to strip a prefix: the rule must not eat it here.
      // Against the WHOLE rule set, so this also proves a keyword rule cannot
      // claim the query first: `redirectToOf` applies the highest priority.
      expect(redirectToOf(all, 'https://www.google.com/search?q=%5Cgh+foo&ie=UTF-8')).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=%5Cgh+foo`,
      );
      expect(redirectToOf(all, 'https://duckduckgo.com/?q=%3Dgh+foo&t=hc')).toBe(
        `chrome-extension://${EXT_ID}/go.html?q=%3Dgh+foo`,
      );
    });
  });
});
