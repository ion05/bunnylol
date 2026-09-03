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
  DRAFT_FIELDS,
  EMPTY_DRAFT,
  buildCommand,
  draftFrom,
  emptyDraft,
  looksLikeUrl,
  originOf,
  parseKeys,
  parsePrefill,
  sameDraft,
  shippedDraftFor,
  splitKeys,
  withScheme,
} from '../src/lib/draft';
import type { Draft } from '../src/lib/draft';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { diffEdit, shortcutId } from '../src/lib/overrides';
import type { BuiltinCommand, Command } from '../src/lib/types';
import { MAX_KEYWORD_LENGTH } from '../src/lib/validate';

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

const claude: BuiltinCommand = {
  keys: ['c'],
  name: 'Claude',
  description: 'Ask Claude.',
  url: 'https://claude.ai',
  handler: 'ai',
  provider: 'claude',
  category: 'ai',
  builtin: true,
};

const builtins: BuiltinCommand[] = [github, claude];

describe('parseKeys', () => {
  it('splits a comma-separated list', () => {
    expect(parseKeys('gh, github')).toEqual({ ok: true, keys: ['gh', 'github'] });
  });

  it('trims, lowercases and dedupes', () => {
    expect(parseKeys(' GH ,gh')).toEqual({ ok: true, keys: ['gh'] });
  });

  it('accepts an empty list: the form reports "no keyword" itself', () => {
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

describe('emptyDraft', () => {
  it('files a new shortcut under "My shortcuts" by default', () => {
    expect(emptyDraft().category).toBe('custom');
  });

  it('honours a section the caller names', () => {
    expect(emptyDraft('sec-work').category).toBe('sec-work');
  });

  it('does not hand out EMPTY_DRAFT itself for a later caller to mutate', () => {
    emptyDraft().name = 'mutated';
    expect(EMPTY_DRAFT.name).toBe('');
  });
});

describe('draftFrom', () => {
  it('joins the keys and blanks the absent optional fields', () => {
    const draft = draftFrom(github);
    expect(draft.keys).toBe('gh, github');
    expect(draft.searchUrl).toBe('https://github.com/search?q={q}');
    // No shipped example, and the scratch field is never seeded from a command.
    expect(draft.example).toBe('');
    expect(draft.newSectionLabel).toBe('');
  });

  it('carries a persisted example across', () => {
    expect(draftFrom({ ...github, example: 'gh facebook/react' }).example).toBe(
      'gh facebook/react',
    );
  });

  it('falls back to "My shortcuts" for a command with no category', () => {
    expect(draftFrom({ ...github, category: '' }).category).toBe('custom');
  });
});

describe('shippedDraftFor', () => {
  it('reads the registry, which is what Reset puts back', () => {
    expect(shippedDraftFor('gh', builtins)?.keys).toBe('gh, github');
  });

  it('returns null for an unknown id, which is how the form spots one of the user’s own', () => {
    expect(shippedDraftFor('u:tix', builtins)).toBeNull();
    expect(shippedDraftFor('', builtins)).toBeNull();
  });

  it('matches on the shortcut id, not on any alias the command answers to', () => {
    // `shortcutId` of a shipped command is its SHIPPED keys[0], which is why a
    // rebind cannot orphan the edit layer. A spare alias is not that id, and
    // resolving one here would make Reset depend on which keyword the row was
    // opened from.
    expect(shippedDraftFor('github', builtins)).toBeNull();
    expect(shippedDraftFor('gh', builtins)?.name).toBe('GitHub');
  });
});

describe('sameDraft', () => {
  it('is true for a draft and its own baseline', () => {
    expect(sameDraft(draftFrom(github), draftFrom(github))).toBe(true);
  });

  it('ignores newSectionLabel, which describes the form and not the shortcut', () => {
    const a = draftFrom(github);
    expect(sameDraft(a, { ...a, newSectionLabel: 'Client work' })).toBe(true);
  });

  it('sees a change in any field the shortcut actually stores', () => {
    // Derived from DRAFT_FIELDS rather than listed: a field added to the draft
    // and forgotten here would make Reset think it had nothing to put back.
    const a = draftFrom(github);
    for (const field of DRAFT_FIELDS) {
      expect(sameDraft(a, { ...a, [field]: 'changed' })).toBe(false);
    }
  });
});

describe('buildCommand', () => {
  it('round-trips a command through draftFrom unchanged', () => {
    expect(buildCommand(draftFrom(github), github, 'gh')).toEqual({ ...github, id: 'gh' });
  });

  it('preserves handler, provider and builtin from the base command', () => {
    const cmd = buildCommand(draftFrom(claude), claude, 'c');
    expect(cmd.handler).toBe('ai');
    expect(cmd.provider).toBe('claude');
    expect(cmd.builtin).toBe(true);
  });

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

  it('keeps the handler of a user-created command that has one', () => {
    // An imported custom command can carry a handler; editing its name used to
    // drop it, which silently changed what the shortcut did.
    const mine: Command = { ...claude, id: 'u:c', builtin: false };
    expect(buildCommand(draftFrom(mine), mine, 'u:c').handler).toBe('ai');
  });

  it('takes the id from the parameter, so a rebind does not change identity', () => {
    const draft = { ...draftFrom(github), keys: 'hub' };
    expect(buildCommand(draft, github, 'gh').id).toBe('gh');
    expect(buildCommand(draft, github, 'gh').keys).toEqual(['hub']);
  });

  it('omits searchUrl and example when they are blank rather than storing ""', () => {
    const draft = { ...draftFrom(github), searchUrl: '  ', example: '  ' };
    const cmd = buildCommand(draft, github, 'gh');
    expect('searchUrl' in cmd).toBe(false);
    expect('example' in cmd).toBe(false);
  });

  it('adds https:// to a scheme-less URL and takes the category from the draft', () => {
    const draft = { ...EMPTY_DRAFT, keys: 'x', url: 'example.com', category: 'sec-work' };
    const cmd = buildCommand(draft, null, 'u:x');
    expect(cmd.url).toBe('https://example.com');
    // Unnarrowed on purpose: this builder does not know which sections exist,
    // and `model/form.ts` is what checks the id against them.
    expect(cmd.category).toBe('sec-work');
  });

  it('falls back to the lenient key split while the form is half-typed', () => {
    const cmd = buildCommand({ ...EMPTY_DRAFT, keys: 'foo bar', url: 'https://x.test' }, null, '');
    expect(cmd.keys).toEqual(['foo bar']);
    // No id claimed at all rather than an empty string, which storage would
    // have to strip back out.
    expect('id' in cmd).toBe(false);
  });

  it('names an unnamed shortcut after its first key', () => {
    const cmd = buildCommand({ ...EMPTY_DRAFT, keys: 'tix', url: 'https://x.test' }, null, '');
    expect(cmd.name).toBe('tix');
  });
});

describe('a Save that changes nothing changes nothing', () => {
  // Derived from the registry rather than from a list of command names, so a
  // command added later is covered without anybody remembering to add it.
  it.each(BUILTIN_COMMANDS.map((cmd) => [shortcutId(cmd), cmd] as const))(
    'opening and saving “%s” unedited stores no edit',
    (id, shipped) => {
      expect(diffEdit(shipped, buildCommand(draftFrom(shipped), shipped, id))).toBeNull();
    },
  );

  it('keeps a meta shortcut’s relative destination relative', () => {
    // `options.html#help` is not scheme-less by accident: `resolve()` stays
    // chrome-free and the dispatch page absolutises it. `https://options.html`
    // is a host that does not exist, and it used to be stored by a Save that
    // touched nothing.
    const help = BUILTIN_COMMANDS.find((cmd) => cmd.url.startsWith('options.html'));
    expect(help).toBeDefined();
    expect(buildCommand(draftFrom(help as Command), help as Command, 'bl').url).toBe(help?.url);
  });

  it('still schemes a destination the user actually typed', () => {
    const draft = { ...draftFrom(github), url: 'example.com' };
    expect(buildCommand(draft, github, 'gh').url).toBe('https://example.com');
  });

  it('still schemes a search URL the user actually typed', () => {
    const draft = { ...draftFrom(github), searchUrl: 'example.com/search?q={q}' };
    expect(buildCommand(draft, github, 'gh').searchUrl).toBe('https://example.com/search?q={q}');
  });
});
