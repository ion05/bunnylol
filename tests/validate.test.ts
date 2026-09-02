/**
 * The validation boundary, tested against the two contracts it exists to keep:
 * the resolver's "a keyword is one word" and the dispatch page's "a destination
 * is a URL we can navigate to". Both used to be enforced by an emptiness check
 * plus a five-scheme blocklist, which let through an alias that can never match
 * and a `defaultEngine` that is not a URL at all.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { AI_PROVIDERS } from '../src/lib/handlers';
import { activeKeywords } from '../src/lib/resolve';
import { DEFAULT_SETTINGS, FORCE_SEARCH_PREFIXES } from '../src/lib/types';
import {
  MAX_KEYWORD_LENGTH,
  isInterceptableAlias,
  validateAlias,
  validateUrlTemplate,
} from '../src/lib/validate';

function alias(raw: string): string | null {
  const check = validateAlias(raw);
  return check.ok ? check.alias : null;
}

function url(raw: string): string | null {
  const check = validateUrlTemplate(raw);
  return check.ok ? check.url : null;
}

function reason(raw: string): string {
  const check = validateUrlTemplate(raw);
  return check.ok ? '' : check.reason;
}

describe('validateAlias', () => {
  it('rejects an alias starting with an escape prefix', () => {
    // Same dead-keyword class as whitespace: resolve() strips the leading
    // escape and plain-searches the remainder, so `=foo` never reaches the key
    // map and the shortcut is unreachable on every surface.
    for (const prefix of FORCE_SEARCH_PREFIXES) {
      const check = validateAlias(`${prefix}foo`);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toContain(prefix);
    }
  });

  it('still accepts an escape character that is not leading', () => {
    expect(validateAlias('a=b')).toEqual({ ok: true, alias: 'a=b' });
  });

  it('accepts a single token and canonicalizes it', () => {
    expect(alias('gh')).toBe('gh');
    expect(alias('  TiX  ')).toBe('tix');
    expect(alias('my-shortcut_2')).toBe('my-shortcut_2');
  });

  /**
   * THE POINT OF THIS FUNCTION. `resolve()` splits the query at the first
   * whitespace, so an alias containing one is not merely awkward — it cannot be
   * typed on any surface, and storing it hides a dead entry in the user's list.
   */
  it.each(['foo bar', 'foo\tbar', 'foo\nbar', 'a b c'])('rejects %j, which can never match', (raw) => {
    expect(alias(raw)).toBeNull();
    expect(validateAlias(raw)).toMatchObject({ ok: false });
  });

  it('explains itself well enough to show a user', () => {
    const check = validateAlias('foo bar');
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toMatch(/space/i);
      expect(check.reason).toContain('foo bar');
    }
  });

  it('rejects an empty alias and one past the length cap', () => {
    expect(alias('')).toBeNull();
    expect(alias('   ')).toBeNull();
    expect(alias('x'.repeat(MAX_KEYWORD_LENGTH))).toBe('x'.repeat(MAX_KEYWORD_LENGTH));
    expect(alias('x'.repeat(MAX_KEYWORD_LENGTH + 1))).toBeNull();
  });

  /**
   * Being storable and being interceptable are different questions, and keeping
   * them apart is deliberate: a non-ASCII alias still works from the `bl`
   * omnibox and the popup, it just cannot go into a DNR regex alternation.
   */
  it('keeps an alias the DNR alternation cannot carry', () => {
    expect(alias('日本')).toBe('日本');
    expect(isInterceptableAlias('日本')).toBe(false);
    expect(isInterceptableAlias('gh')).toBe(true);
  });

  it('agrees with activeKeywords about what a rule may carry', () => {
    for (const keyword of activeKeywords(BUILTIN_COMMANDS)) {
      expect(validateAlias(keyword)).toEqual({ ok: true, alias: keyword });
      expect(isInterceptableAlias(keyword)).toBe(true);
    }
  });
});

describe('validateUrlTemplate', () => {
  it('accepts an http(s) URL and returns it with its placeholders intact', () => {
    expect(url('https://kagi.com/search?q={q}')).toBe('https://kagi.com/search?q={q}');
    expect(url('  https://tix.example/  ')).toBe('https://tix.example/');
    expect(url('http://localhost:3000/{q}')).toBe('http://localhost:3000/{q}');
    expect(url('https://example.test/search?q=%s')).toBe('https://example.test/search?q=%s');
  });

  /**
   * The failure the blocklist could not see. `toNavigableUrl` treats anything
   * without a scheme as an extension-relative path, so an unparseable
   * `defaultEngine` does not break one shortcut — it sends every unmatched
   * query to a missing extension resource.
   */
  it('rejects prose, which used to be accepted as a search engine', () => {
    expect(url('not a url')).toBeNull();
    expect(reason('not a url')).toMatch(/not a URL/i);
    expect(url('google.com/search?q={q}')).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>x</script>',
    'vbscript:msgbox(1)',
    'blob:https://example.test/abc',
    'filesystem:https://example.test/temporary/x',
    'mailto:someone@example.test',
    'ftp://files.example.test/pub',
    'file:///etc/passwd',
    'chrome://settings',
  ])('rejects %j', (raw) => {
    expect(url(raw)).toBeNull();
  });

  it('rejects a URL with no host', () => {
    expect(url('https://')).toBeNull();
    expect(url('https://?q={q}')).toBeNull();
  });

  it('rejects an empty template', () => {
    expect(url('')).toBeNull();
    expect(url('   ')).toBeNull();
  });

  /** Everything the extension ships has to pass its own boundary. */
  it('accepts every URL this build ships', () => {
    expect(url(DEFAULT_SETTINGS.defaultEngine)).toBe(DEFAULT_SETTINGS.defaultEngine);
    for (const provider of AI_PROVIDERS) {
      expect(url(provider.template), provider.id).toBe(provider.template);
      expect(url(provider.home), provider.id).toBe(provider.home);
    }
    for (const cmd of BUILTIN_COMMANDS) {
      // The `meta` builtins are the one exception, and deliberately so: they
      // resolve to extension-relative paths (`options.html#help`) that
      // `toNavigableUrl` expands. They ship with the extension and never pass
      // through storage, which is exactly why a scheme-less string reaching
      // this boundary from a file is a bug rather than a feature.
      //
      // Selected by handler, not by category: a shortcut can be moved into any
      // section, but `handler` is never user-editable.
      if (cmd.handler === 'meta') {
        expect(url(cmd.url), cmd.keys[0]).toBeNull();
        continue;
      }
      expect(url(cmd.url), cmd.keys[0]).toBe(cmd.url);
      if (cmd.searchUrl) expect(url(cmd.searchUrl), cmd.keys[0]).toBe(cmd.searchUrl);
    }
    for (const engine of SEARCH_ENGINES) {
      expect(url(`https://${engine.host}/search?q={q}`)).toBeTruthy();
    }
  });
});
