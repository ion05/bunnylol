/**
 * `src/lib/text.ts` is what the popup, the omnibox, the dispatch page, the
 * options page and the DNR sync now share instead of their private copies.
 * Those copies had already drifted in the small ways copies do — background.ts
 * and popup.ts carried different comments on the same `prettyUrl` body,
 * options.ts spelled `errorText` as an if/return where popup.ts used a ternary
 * — and five copies of the error stringifier is five places a fix has to land.
 * These tests pin the single definition each surface now inherits.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`, so nothing in it may touch the DOM at module scope.
 */

import { describe, expect, it } from 'vitest';
import { clone, errorText, firstToken, prettyUrl, restOfLine, stripScheme } from '../src/lib/text';
import { withPassthrough } from '../src/lib/resolve';

describe('firstToken', () => {
  it('takes the keyword off the front, ignoring surrounding whitespace', () => {
    expect(firstToken('  gh facebook/react ')).toBe('gh');
  });

  it('returns the whole thing when there are no arguments', () => {
    expect(firstToken('gh')).toBe('gh');
    expect(firstToken('  gh  ')).toBe('gh');
  });

  it('splits on any whitespace, not just a space', () => {
    expect(firstToken('gh\tfacebook/react')).toBe('gh');
    expect(firstToken('gh\nfacebook/react')).toBe('gh');
  });

  it('is empty for empty or blank input', () => {
    expect(firstToken('')).toBe('');
    expect(firstToken('   ')).toBe('');
  });
});

describe('restOfLine', () => {
  it('returns everything after the keyword', () => {
    expect(restOfLine('gh facebook/react')).toBe('facebook/react');
  });

  it('preserves internal spacing and case', () => {
    expect(restOfLine('gh   Foo  Bar ')).toBe('Foo  Bar');
  });

  it('is empty when there is nothing after the keyword', () => {
    expect(restOfLine('gh')).toBe('');
    expect(restOfLine('  gh  ')).toBe('');
    expect(restOfLine('')).toBe('');
  });
});

describe('stripScheme', () => {
  it('drops http and https for display', () => {
    expect(stripScheme('https://x.test/a')).toBe('x.test/a');
    expect(stripScheme('http://x.test')).toBe('x.test');
  });

  it('leaves anything else alone', () => {
    expect(stripScheme('options.html#help')).toBe('options.html#help');
    expect(stripScheme('chrome-extension://abc/go.html')).toBe('chrome-extension://abc/go.html');
    expect(stripScheme('')).toBe('');
  });
});

describe('prettyUrl', () => {
  it('hides the passthrough marker, which is our plumbing and not the user’s URL', () => {
    expect(prettyUrl(withPassthrough('https://www.google.com/search?q=a'))).toBe(
      'www.google.com/search?q=a',
    );
  });

  it('keeps the rest of the query string around the marker', () => {
    expect(prettyUrl('https://duckduckgo.com/?blpass=1&q=a')).toBe('duckduckgo.com/?q=a');
  });

  it('only de-schemes a URL that carries no marker', () => {
    expect(prettyUrl('https://github.com/facebook/react')).toBe('github.com/facebook/react');
  });
});

describe('errorText', () => {
  it('uses an Error’s message', () => {
    expect(errorText(new Error('storage is full'))).toBe('storage is full');
  });

  it('stringifies anything else, so a rejected non-Error still says something', () => {
    expect(errorText('plain string')).toBe('plain string');
    expect(errorText(null)).toBe('null');
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText(404)).toBe('404');
  });
});

describe('clone', () => {
  it('returns a structurally equal value the caller can mutate', () => {
    const source = { custom: [{ keys: ['tix'] }], disabled: [] };
    const copy = clone(source);
    expect(copy).toEqual(source);
    copy.custom[0].keys.push('tickets');
    expect(source.custom[0].keys).toEqual(['tix']);
  });
});
