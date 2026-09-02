/**
 * `src/options/model/form.ts` is the add/edit form's validation and
 * command-building, pulled out of `options.ts` so it can be exercised without
 * a DOM. Importing the module at all is half the test: it must load under
 * vitest's `environment: 'node'`.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT } from '../src/lib/draft';
import { DEFAULT_OVERRIDES, FALLBACK_SECTION } from '../src/lib/types';
import type { BuiltinCommand, Command } from '../src/lib/types';
import {
  buildCommand,
  engineProblem,
  previewOverrides,
  validateDraft,
} from '../src/options/model/form';
import type { FormContext } from '../src/options/model/form';

const github: BuiltinCommand = {
  keys: ['gh', 'github'],
  name: 'GitHub',
  description: 'Open a repo, or search GitHub.',
  url: 'https://github.com',
  category: 'dev',
  builtin: true,
};

const builtins: BuiltinCommand[] = [github];

const emptyCtx: FormContext = { editingId: '', owners: new Map(), custom: [], builtins };

describe('validateDraft', () => {
  it('rejects an empty keys list', () => {
    const problems = validateDraft({ ...EMPTY_DRAFT, url: 'https://example.com' }, emptyCtx);
    expect(problems).toContainEqual({
      level: 'error',
      field: 'keys',
      text: 'Add at least one keyword — that is what you type in the address bar.',
    });
  });

  it('warns about a non-interceptable alias but does not error', () => {
    // Passes `validateAlias` (no whitespace) but fails `SAFE_KEYWORD` (a dot).
    const problems = validateDraft(
      { ...EMPTY_DRAFT, keys: 'a.b', url: 'https://example.com' },
      emptyCtx,
    );
    expect(problems.some((problem) => problem.level === 'error')).toBe(false);
    expect(
      problems.some(
        (problem) => problem.level === 'warn' && problem.text.includes('not intercepted'),
      ),
    ).toBe(true);
  });

  it('errors when another custom shortcut owns the alias and warns when a builtin does', () => {
    const mine: Command = {
      id: 'u:x',
      keys: ['tix'],
      name: 'Tickets',
      description: '',
      url: 'https://example.com',
      category: 'custom',
      builtin: false,
    };
    const ctx: FormContext = {
      editingId: '',
      owners: new Map([
        ['tix', 'u:x'],
        ['gh', 'gh'],
      ]),
      custom: [mine],
      builtins,
    };
    const problems = validateDraft(
      { ...EMPTY_DRAFT, keys: 'tix, gh', url: 'https://example.com' },
      ctx,
    );
    expect(
      problems.some(
        (problem) => problem.level === 'error' && problem.text.includes('your shortcut'),
      ),
    ).toBe(true);
    expect(
      problems.some(
        (problem) => problem.level === 'warn' && problem.text.includes('currently opens GitHub'),
      ),
    ).toBe(true);
  });

  it('names the builtin’s spare aliases when it has them', () => {
    const ctx: FormContext = { editingId: '', owners: new Map([['gh', 'gh']]), custom: [], builtins };
    const problems = validateDraft({ ...EMPTY_DRAFT, keys: 'gh', url: 'https://example.com' }, ctx);
    const warning = problems.find((problem) => problem.level === 'warn' && problem.field === 'keys');
    expect(warning?.text).toContain('stays reachable as github');
  });

  it('requires a destination URL', () => {
    const problems = validateDraft({ ...EMPTY_DRAFT, keys: 'x' }, emptyCtx);
    expect(
      problems.some(
        (problem) => problem.level === 'error' && problem.field === 'url' && problem.text.includes('required'),
      ),
    ).toBe(true);
  });

  it('rejects a destination URL that is not http(s)', () => {
    // `withScheme` leaves an explicit scheme alone, so this reaches
    // `urlProblem`'s protocol branch rather than its parse branch.
    const problems = validateDraft(
      { ...EMPTY_DRAFT, keys: 'x', url: 'ftp://example.com' },
      emptyCtx,
    );
    expect(problems).toContainEqual({
      level: 'error',
      field: 'url',
      text: 'Destination URL must start with http:// or https://.',
    });
  });

  it('warns when searchUrl has no {q}', () => {
    const problems = validateDraft(
      { ...EMPTY_DRAFT, keys: 'x', url: 'https://example.com', searchUrl: 'https://example.com/search' },
      emptyCtx,
    );
    expect(
      problems.some((problem) => problem.level === 'warn' && problem.field === 'searchUrl'),
    ).toBe(true);
  });
});

describe('buildCommand', () => {
  it('adds https:// to a scheme-less URL', () => {
    const cmd = buildCommand({ ...EMPTY_DRAFT, keys: 'x', url: 'example.com' }, new Set());
    expect(cmd.url).toBe('https://example.com');
  });

  it('falls back to the lenient key split while the form is half-typed', () => {
    // No comma, so `parseKeys` (via `validateAlias`) rejects the whole thing as
    // one space-containing alias; `buildCommand` must not blank the row.
    const cmd = buildCommand({ ...EMPTY_DRAFT, keys: 'foo bar', url: 'https://example.com' }, new Set());
    expect(cmd.keys).toEqual(['foo bar']);
  });

  it('degrades a category naming no known section to the fallback', () => {
    // Invariant 17: a custom command filed under a section that has since been
    // deleted has nowhere else to go, so it lands in "My shortcuts".
    const cmd = buildCommand(
      { ...EMPTY_DRAFT, keys: 'x', url: 'https://example.com', category: 'sec-gone' },
      new Set(['sec-work']),
    );
    expect(cmd.category).toBe(FALLBACK_SECTION);
  });

  it('keeps a category the caller says exists', () => {
    const cmd = buildCommand(
      { ...EMPTY_DRAFT, keys: 'x', url: 'https://example.com', category: 'sec-work' },
      new Set(['sec-work']),
    );
    expect(cmd.category).toBe('sec-work');
  });
});

describe('previewOverrides', () => {
  it('appends the draft when not editing', () => {
    const draft: Command = {
      keys: ['x'],
      name: 'X',
      description: '',
      url: 'https://example.com',
      category: 'custom',
      builtin: false,
    };
    const result = previewOverrides(draft, '', DEFAULT_OVERRIDES);
    expect(result.custom).toEqual([draft]);
  });

  it('replaces the matching custom command when editing', () => {
    const existing: Command = {
      id: 'u:x',
      keys: ['x'],
      name: 'Old',
      description: '',
      url: 'https://old.example.com',
      category: 'custom',
      builtin: false,
    };
    const draft: Command = { ...existing, name: 'New' };
    const result = previewOverrides(draft, 'u:x', { ...DEFAULT_OVERRIDES, custom: [existing] });
    expect(result.custom).toEqual([draft]);
  });
});

describe('engineProblem', () => {
  it('rejects a scheme-less template, a placeholder in the host, and a single-label host that is not localhost', () => {
    expect(engineProblem('example.com/search?q={q}')?.text).toContain('has no scheme');
    expect(engineProblem('https://{q}.example.com/search')?.text).toContain('is not a host name');
    expect(engineProblem('https://search/?q={q}')?.text).toContain('is not a full domain name');
  });

  it('accepts https://localhost:8080/?q={q}', () => {
    expect(engineProblem('https://localhost:8080/?q={q}')).toBeNull();
  });
});
