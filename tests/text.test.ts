/**
 * `src/lib/text.ts` is what the popup, the omnibox, the dispatch page, the
 * options page and the DNR sync now share instead of their private copies.
 * Those copies had already drifted in the small ways copies do: background.ts
 * and popup.ts carried different comments on the same `prettyUrl` body,
 * options.ts spelled `errorText` as an if/return where popup.ts used a ternary,
 * and five copies of the error stringifier is five places a fix has to land.
 * These tests pin the single definition each surface now inherits.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`, so nothing in it may touch the DOM at module scope.
 */

import { describe, expect, it } from 'vitest';
import { at } from './helpers/at';
import {
  clone,
  countShipped,
  countShortcuts,
  errorText,
  firstToken,
  joinClauses,
  prettyUrl,
  restOfLine,
  stripScheme,
} from '../src/lib/text';
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
    at(copy.custom, 0).keys.push('tickets');
    expect(at(source.custom, 0).keys).toEqual(['tix']);
  });
});

describe('joinClauses', () => {
  it('answers nothing for nothing, so the caller can test the sentence itself', () => {
    expect(joinClauses([])).toBe('');
  });

  it('leaves a single clause alone rather than dressing it up', () => {
    expect(joinClauses(['turns off 1 shipped shortcut'])).toBe('turns off 1 shipped shortcut');
  });

  it('joins two clauses with "and" and no comma', () => {
    expect(joinClauses(['adds 2 sections', 'leaves out 1 section'])).toBe(
      'adds 2 sections and leaves out 1 section',
    );
  });

  it('commas every clause but the last at four, which is where the copy caps', () => {
    // Four is the most the import dialog ever builds; past that the sentence
    // stops being readable and the copy splits, so this is the boundary case.
    expect(joinClauses(['a', 'b', 'c', 'd'])).toBe('a, b, c and d');
  });
});

describe('countShortcuts', () => {
  it('agrees the noun with the number', () => {
    expect(countShortcuts(1)).toBe('1 shortcut');
    expect(countShortcuts(0)).toBe('0 shortcuts');
    expect(countShortcuts(3)).toBe('3 shortcuts');
  });

  it('is the plain count, so the shipped one stays the only qualified wording', () => {
    // Both the import dialog and the Sections card count shortcuts, and they
    // used to reach for two different helpers in two different layers. This one
    // says nothing about where a shortcut came from; `countShipped` does.
    expect(countShortcuts(2)).not.toContain('shipped');
  });
});

describe('countShipped', () => {
  it('agrees the noun with the number', () => {
    expect(countShipped(1)).toBe('1 shipped shortcut');
    expect(countShipped(0)).toBe('0 shipped shortcuts');
    expect(countShipped(3)).toBe('3 shipped shortcuts');
  });

  it('says "shipped", never "built-in"', () => {
    // "Built-in" is what the export sentence calls the registry FILE. One word
    // doing both jobs in one card is a word doing neither.
    expect(countShipped(2)).not.toContain('built-in');
  });
});
