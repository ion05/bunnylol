/**
 * `src/lib/draft.ts` is the string half of the add/edit form, kept out of the
 * options page so it can be exercised without a DOM. `src/options/views/form.ts`
 * owns the widgets; everything that decides what a typed line MEANS lives here.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`.
 */

import { describe, expect, it } from 'vitest';
import { buildCommand, draftFrom, parseKeys, parsePrefill, withScheme } from '../src/lib/draft';
import type { Draft } from '../src/lib/draft';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { diffEdit, shortcutId } from '../src/lib/overrides';
import type { BuiltinCommand, Command } from '../src/lib/types';

const github: BuiltinCommand = {
  keys: ['gh', 'github'],
  name: 'GitHub',
  description: 'Open a repo, or search GitHub.',
  url: 'https://github.com',
  searchUrl: 'https://github.com/search?q={q}',
  handler: 'github',
  category: 'dev',
  builtin: true,
};

describe('parseKeys', () => {
  it('splits a comma-separated list', () => {
    expect(parseKeys('gh, github')).toEqual({ ok: true, keys: ['gh', 'github'] });
  });

  it('refuses an alias with a space, which no surface could ever match', () => {
    const result = parseKeys('foo bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/space/);
      expect(result.reason).toMatch(/Separate keywords with commas/);
    }
  });
});

describe('withScheme', () => {
  it('assumes https for a scheme-less host', () => {
    expect(withScheme('example.com')).toBe('https://example.com');
    expect(withScheme('  example.com/x  ')).toBe('https://example.com/x');
  });
});

describe('parsePrefill', () => {
  it('reads `add tix <template>` as a keyword plus a search URL', () => {
    const draft = parsePrefill('tix https://example.com/search?q={q}');
    expect(draft.keys).toBe('tix');
    expect(draft.searchUrl).toBe('https://example.com/search?q={q}');
    // No plain URL was given, so the destination falls back to the origin.
    expect(draft.url).toBe('https://example.com/');
    expect(draft.name).toBe('');
  });
});

describe('buildCommand', () => {
  it('never lets a draft set handler, provider, builtin or id (invariant 16)', () => {
    // The form shows none of these, so the only way one reaches a draft is a
    // hand-written object: exactly what an import is.
    const hostile = {
      ...draftFrom(github),
      handler: 'ai',
      provider: 'evil',
      builtin: true,
      id: 'not-this',
    } as unknown as Draft;
    const cmd = buildCommand(hostile, null, 'u:mine');
    expect(cmd.handler).toBeUndefined();
    expect(cmd.provider).toBeUndefined();
    expect(cmd.builtin).toBe(false);
    expect(cmd.id).toBe('u:mine');
  });
});

describe('a Save that changes nothing changes nothing', () => {
  // Derived from the registry rather than from a list of command names, so a
  // command added later is covered without anybody remembering to add it.

  it('opening and saving any shipped shortcut unedited stores no edit', () => {
    const edited = BUILTIN_COMMANDS.filter(
      (shipped) =>
        diffEdit(shipped, buildCommand(draftFrom(shipped), shipped, shortcutId(shipped))) !== null,
    ).map((shipped) => shortcutId(shipped));
    expect(edited).toEqual([]);
  });

  it('keeps a meta shortcut’s relative destination relative', () => {
    // `options.html#help` is not scheme-less by accident: `resolve()` stays
    // chrome-free and the dispatch page absolutises it. `https://options.html`
    // is a host that does not exist, and it used to be stored by a Save that
    // touched nothing.
    const help = BUILTIN_COMMANDS.find((cmd) => cmd.url.startsWith('options.html'));
    expect(help).toBeDefined();
    expect(buildCommand(draftFrom(help as Command), help as Command, 'bl').url).toBe(help?.url);
  });
});
