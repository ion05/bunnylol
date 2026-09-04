/**
 * The validation boundary, tested against the contracts it exists to keep: the
 * resolver's "a keyword is one word", the dispatch page's "a destination is a
 * URL we can navigate to", and, for sections, "an id is one canonical token"
 * and "a label is display text a human can actually see". The first two used to
 * be enforced by an emptiness check plus a five-scheme blocklist, which let
 * through an alias that can never match and a `defaultEngine` that is not a URL
 * at all.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { AI_PROVIDERS } from '../src/lib/handlers';
import { DEFAULT_SETTINGS, FORCE_SEARCH_PREFIXES } from '../src/lib/types';
import {
  MAX_KEYWORD_LENGTH,
  validateAlias,
  validateSectionId,
  validateSectionLabel,
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

function sectionId(raw: string): string | null {
  const check = validateSectionId(raw);
  return check.ok ? check.id : null;
}

function labelReason(raw: string): string {
  const check = validateSectionLabel(raw);
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

  it('rejects an alias with whitespace in it, which can never match', () => {
    for (const raw of ['foo bar', 'foo\tbar', 'foo\nbar', 'a b c']) {
      expect(alias(raw), raw).toBeNull();
      expect(validateAlias(raw), raw).toMatchObject({ ok: false });
    }
  });

  it('rejects an empty alias and one past the length cap', () => {
    expect(alias('')).toBeNull();
    expect(alias('   ')).toBeNull();
    expect(alias('x'.repeat(MAX_KEYWORD_LENGTH))).toBe('x'.repeat(MAX_KEYWORD_LENGTH));
    expect(alias('x'.repeat(MAX_KEYWORD_LENGTH + 1))).toBeNull();
  });
});

describe('validateUrlTemplate', () => {
  it('accepts an http(s) URL and returns it with its placeholders intact', () => {
    expect(url('https://kagi.com/search?q={q}')).toBe('https://kagi.com/search?q={q}');
    expect(url('  https://tix.example/  ')).toBe('https://tix.example/');
    expect(url('http://localhost:3000/{q}')).toBe('http://localhost:3000/{q}');
    expect(url('https://example.test/search?q=%s')).toBe('https://example.test/search?q=%s');
  });

  it('rejects every scheme go.html could not open', () => {
    const refused = [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'mailto:someone@example.test',
      'file:///etc/passwd',
      'chrome://settings',
      'not a url at all',
      'example.test/search?q={q}',
      '',
    ];
    for (const raw of refused) expect(url(raw), raw).toBeNull();
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

describe('validateSectionId', () => {
  it('trims, lowercases and returns the canonical slug', () => {
    expect(sectionId(' Work ')).toBe('work');
    expect(sectionId('MY-STUFF')).toBe('my-stuff');
    expect(sectionId('side-projects-2')).toBe('side-projects-2');
  });

  it('accepts a slug that names an Object.prototype member', () => {
    expect(sectionId(' Constructor ')).toBe('constructor');
  });
});

describe('validateSectionLabel', () => {
  it('rejects an empty label', () => {
    expect(labelReason('')).toMatch(/empty/);
    expect(labelReason('   ')).toMatch(/empty/);
  });
});
