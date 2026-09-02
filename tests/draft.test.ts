/**
 * `src/lib/draft.ts` is the string half of the add/edit form, pulled out of the
 * options page so it can be exercised without a DOM. The form's widgets are the
 * only thing left in `options.ts`; everything that decides what a typed line
 * MEANS lives here.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT,
  looksLikeUrl,
  originOf,
  parseKeys,
  parsePrefill,
  splitKeys,
  withScheme,
} from '../src/lib/draft';
import { MAX_KEYWORD_LENGTH } from '../src/lib/validate';

describe('parseKeys', () => {
  it('splits a comma-separated list', () => {
    expect(parseKeys('gh, github')).toEqual({ ok: true, keys: ['gh', 'github'] });
  });

  it('trims, lowercases and dedupes', () => {
    expect(parseKeys(' GH ,gh')).toEqual({ ok: true, keys: ['gh'] });
  });

  it('accepts an empty list — the form reports "no keyword" itself', () => {
    expect(parseKeys('')).toEqual({ ok: true, keys: [] });
    expect(parseKeys('  ,  ')).toEqual({ ok: true, keys: [] });
  });

  it('refuses an alias with a space, which no surface could ever match', () => {
    const result = parseKeys('foo bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/space/);
      expect(result.reason).toMatch(/Separate keywords with commas/);
    }
  });

  it('refuses an alias starting with an escape prefix (invariant 6)', () => {
    expect(parseKeys('=x').ok).toBe(false);
    expect(parseKeys('\\x').ok).toBe(false);
  });

  it('refuses an over-long alias', () => {
    const result = parseKeys('x'.repeat(MAX_KEYWORD_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(`${MAX_KEYWORD_LENGTH} characters`);
  });
});

describe('splitKeys', () => {
  it('keeps a half-typed alias the strict parser would reject', () => {
    expect(splitKeys('foo bar')).toEqual(['foo bar']);
  });

  it('lowercases, trims, dedupes and drops empties', () => {
    expect(splitKeys(' GH , gh ,, github ')).toEqual(['gh', 'github']);
    expect(splitKeys('')).toEqual([]);
  });
});

describe('looksLikeUrl', () => {
  it('accepts a scheme or a dotted host', () => {
    expect(looksLikeUrl('https://example.com')).toBe(true);
    expect(looksLikeUrl('example.com/x')).toBe(true);
    expect(looksLikeUrl('sub.example.co.uk?a=1')).toBe(true);
  });

  it('rejects a bare word, which is a name rather than a destination', () => {
    expect(looksLikeUrl('hello')).toBe(false);
    expect(looksLikeUrl('')).toBe(false);
  });
});

describe('withScheme', () => {
  it('assumes https for a scheme-less host', () => {
    expect(withScheme('example.com')).toBe('https://example.com');
    expect(withScheme('  example.com/x  ')).toBe('https://example.com/x');
  });

  it('leaves an existing scheme alone', () => {
    expect(withScheme('ftp://x')).toBe('ftp://x');
    expect(withScheme('http://x.test')).toBe('http://x.test');
  });

  it('leaves blank input blank rather than inventing https://', () => {
    expect(withScheme('')).toBe('');
    expect(withScheme('  ')).toBe('');
  });
});

describe('originOf', () => {
  it('reduces a URL to its origin with a trailing slash', () => {
    expect(originOf('https://example.com/search?q={q}')).toBe('https://example.com/');
  });

  it('returns the input unchanged when it does not parse', () => {
    expect(originOf('not a url')).toBe('not a url');
  });
});

describe('parsePrefill', () => {
  it('is EMPTY_DRAFT for nothing at all', () => {
    expect(parsePrefill('')).toEqual(EMPTY_DRAFT);
    expect(parsePrefill('   ')).toEqual(EMPTY_DRAFT);
  });

  it('does not hand out EMPTY_DRAFT itself for a later caller to mutate', () => {
    const draft = parsePrefill('');
    draft.name = 'mutated';
    expect(EMPTY_DRAFT.name).toBe('');
  });

  it('reads `add tix <template>` as a keyword plus a search URL', () => {
    const draft = parsePrefill('tix https://example.com/search?q={q}');
    expect(draft.keys).toBe('tix');
    expect(draft.searchUrl).toBe('https://example.com/search?q={q}');
    // No plain URL was given, so the destination falls back to the origin.
    expect(draft.url).toBe('https://example.com/');
    expect(draft.name).toBe('');
  });

  it('treats %s as a placeholder too', () => {
    expect(parsePrefill('tix example.com/s?q=%s').searchUrl).toBe('https://example.com/s?q=%s');
  });

  it('collects leftover words as the name and keeps a bare URL as the destination', () => {
    const draft = parsePrefill('tix Tickets https://tix.test/');
    expect(draft.keys).toBe('tix');
    expect(draft.name).toBe('Tickets');
    expect(draft.url).toBe('https://tix.test/');
    expect(draft.searchUrl).toBe('');
  });

  it('takes both URLs when both a destination and a template are given', () => {
    const draft = parsePrefill('tix https://tix.test/ https://tix.test/search?q={q}');
    expect(draft.url).toBe('https://tix.test/');
    expect(draft.searchUrl).toBe('https://tix.test/search?q={q}');
  });

  it('leaves the keyword empty when the line starts with a URL', () => {
    const draft = parsePrefill('https://x.test/');
    expect(draft.keys).toBe('');
    expect(draft.url).toBe('https://x.test/');
  });

  it('files everything under the fallback section', () => {
    expect(parsePrefill('tix https://tix.test/').category).toBe('custom');
  });
});
