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
import type { Entry } from '../src/options/model/browse';
import {
  NEW_SECTION_VALUE,
  buildCommand,
  engineProblem,
  previewCommands,
  previewOverrides,
  validateDraft,
} from '../src/options/model/form';
import type { FormContext } from '../src/options/model/form';
// The route lookup lives with the view, but it is pure and the module loads
// under `environment: 'node'`, which is itself worth asserting.
import { findEntry } from '../src/options/views/form';

const github: BuiltinCommand = {
  keys: ['gh', 'github'],
  name: 'GitHub',
  description: 'Open a repo, or search GitHub.',
  url: 'https://github.com',
  category: 'dev',
  builtin: true,
};

const settings: BuiltinCommand = {
  keys: ['set'],
  name: 'Settings',
  description: '',
  url: 'options.html#settings',
  category: 'meta',
  builtin: true,
};

const builtins: BuiltinCommand[] = [github];

const emptyCtx: FormContext = {
  editingId: '',
  owners: new Map(),
  custom: [],
  builtins,
  sections: [],
};

describe('validateDraft', () => {
  it('rejects an empty keys list', () => {
    const problems = validateDraft({ ...EMPTY_DRAFT, url: 'https://example.com' }, emptyCtx);
    expect(problems).toContainEqual({
      level: 'error',
      field: 'keys',
      text: 'Add at least one keyword. That is what you type in the address bar.',
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
      sections: [],
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
    const ctx: FormContext = {
      editingId: '',
      owners: new Map([['gh', 'gh']]),
      custom: [],
      builtins,
      sections: [],
    };
    const problems = validateDraft({ ...EMPTY_DRAFT, keys: 'gh', url: 'https://example.com' }, ctx);
    const warning = problems.find((problem) => problem.level === 'warn' && problem.field === 'keys');
    expect(warning?.text).toContain('Your shortcut will take over');
    expect(warning?.text).toContain('stays reachable as github');
  });

  it('does not promise a shipped shortcut will take over an earlier shipped one', () => {
    // Registry order decides between two shipped shortcuts (invariant 10), and
    // the edited one is second here, so it does NOT get the alias. Saying it
    // would was a lie the preview then confirmed and the resolver contradicted.
    const ctx: FormContext = {
      editingId: 'set',
      owners: new Map([['gh', 'gh']]),
      custom: [],
      builtins: [...builtins, settings],
      sections: [],
    };
    const problems = validateDraft({ ...EMPTY_DRAFT, keys: 'gh', url: 'https://example.com' }, ctx);
    const warning = problems.find((problem) => problem.level === 'warn' && problem.field === 'keys');
    expect(warning?.text).toBe(
      '“gh” currently opens GitHub. GitHub comes first in the shipped list and keeps “gh”; this shortcut will not answer to it in the address bar.',
    );
  });

  it('says a shipped shortcut takes over one that comes later in the registry', () => {
    const ctx: FormContext = {
      editingId: 'gh',
      owners: new Map([['set', 'set']]),
      custom: [],
      builtins: [...builtins, settings],
      sections: [],
    };
    const problems = validateDraft({ ...EMPTY_DRAFT, keys: 'set', url: 'https://example.com' }, ctx);
    const warning = problems.find((problem) => problem.level === 'warn' && problem.field === 'keys');
    // "This", not "Your": a shipped shortcut is not the user's own.
    expect(warning?.text).toContain('This shortcut will take over');
    expect(warning?.text).toContain('loses its only keyword');
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

  it('errors when the category is "New section…" and the label is blank', () => {
    const problems = validateDraft(
      { ...EMPTY_DRAFT, keys: 'x', url: 'https://example.com', category: NEW_SECTION_VALUE },
      emptyCtx,
    );
    expect(problems).toContainEqual({
      level: 'error',
      field: 'category',
      text: "The new section's name is empty.",
    });
  });

  it('errors when the new section reuses a name a group already has', () => {
    // Checked against the labels in EFFECT, so a shipped group counts even
    // though no `sections` entry names it.
    const problems = validateDraft(
      {
        ...EMPTY_DRAFT,
        keys: 'x',
        url: 'https://example.com',
        category: NEW_SECTION_VALUE,
        newSectionLabel: ' developer ',
      },
      emptyCtx,
    );
    expect(
      problems.some(
        (problem) => problem.level === 'error' && problem.field === 'category',
      ),
    ).toBe(true);
  });

  it('accepts a new section with a free name', () => {
    const problems = validateDraft(
      {
        ...EMPTY_DRAFT,
        keys: 'x',
        url: 'https://example.com',
        category: NEW_SECTION_VALUE,
        newSectionLabel: 'Client work',
      },
      emptyCtx,
    );
    expect(problems.some((problem) => problem.field === 'category')).toBe(false);
  });

  it('says nothing about the section label when the category is a real section', () => {
    // The label is form scratch space: left over from a cancelled "New
    // section…" it must not fail a save that no longer creates one.
    const problems = validateDraft(
      {
        ...EMPTY_DRAFT,
        keys: 'x',
        url: 'https://example.com',
        category: 'dev',
        newSectionLabel: 'Developer',
      },
      emptyCtx,
    );
    expect(problems.some((problem) => problem.field === 'category')).toBe(false);
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

/**
 * Only the narrowing. This `buildCommand` is `lib/draft`'s with the draft's
 * open category run through `normalizeCategory` first, so everything else it
 * does (the scheme, the lenient key split, refusing to take `handler`,
 * `provider`, `builtin` or `id` off the draft) is the shared builder's and is
 * driven in `tests/draft.test.ts` `describe('buildCommand')`. Asserting it
 * again here tests the same function twice and would go stale against the one
 * that actually holds the behaviour.
 */
describe('buildCommand narrows the category', () => {
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

  it('narrows the category and still carries the base command’s behaviour', () => {
    // One builder: the narrowing is this module's, everything else is
    // `lib/draft`'s, so the preview and the save cannot disagree.
    const cmd = buildCommand(
      { ...EMPTY_DRAFT, keys: 'gh', url: 'https://github.com', category: 'sec-gone' },
      new Set(['dev']),
      github,
      'gh',
    );
    expect(cmd.category).toBe(FALLBACK_SECTION);
    expect(cmd.builtin).toBe(true);
    expect(cmd.id).toBe('gh');
  });
});

describe('previewOverrides', () => {
  const mine: Command = {
    id: 'u:x',
    keys: ['x'],
    name: 'X',
    description: '',
    url: 'https://example.com',
    category: 'custom',
    builtin: false,
  };

  it('appends the draft when not editing', () => {
    expect(previewOverrides(DEFAULT_OVERRIDES, '', mine).custom).toEqual([mine]);
  });

  it('replaces the matching custom command IN PLACE when editing', () => {
    // In place, not appended: `buildKeyMap` is first-writer-wins, so moving the
    // draft to the front of `custom` would hand it an alias an earlier custom
    // shortcut owns and keeps.
    const other: Command = { ...mine, id: 'u:a', keys: ['a'], name: 'A' };
    const existing: Command = { ...mine, name: 'Old', url: 'https://old.example.com' };
    const draft: Command = { ...mine, name: 'New' };
    const result = previewOverrides(
      { ...DEFAULT_OVERRIDES, custom: [other, existing] },
      'u:x',
      draft,
    );
    expect(result.custom).toEqual([other, draft]);
  });

  it('lifts the edited shortcut out of disabled and deleted', () => {
    // The preview is about the definition being typed, not about whether the
    // shortcut is currently switched on; `paintPreview` says so in words.
    const result = previewOverrides(
      { ...DEFAULT_OVERRIDES, disabled: ['gh', 'r'], deleted: ['gh'] },
      'gh',
    );
    expect(result.disabled).toEqual(['r']);
    expect(result.deleted).toEqual([]);
    expect(result.custom).toEqual(DEFAULT_OVERRIDES.custom);
  });
});

describe('previewCommands', () => {
  const claude: BuiltinCommand = {
    keys: ['c', 'claude'],
    name: 'Claude',
    description: '',
    url: 'https://claude.ai',
    category: 'ai',
    builtin: true,
  };
  const registry: BuiltinCommand[] = [claude, github, settings];

  it('keeps a shipped shortcut at its registry position', () => {
    // The bug: splicing the draft into `custom` put it ahead of every builtin,
    // so rebinding Settings onto `c` PREVIEWED as Settings and RESOLVED as
    // Claude after the save. Registry order decides between two shipped
    // shortcuts, and the preview has to be the real resolver.
    const draft: Command = { ...settings, id: 'set', keys: ['c'] };
    const commands = previewCommands(registry, DEFAULT_OVERRIDES, draft, 'set', true);
    expect(commands.map((cmd) => cmd.id)).toEqual(['c', 'gh', 'set']);
    expect(commands.find((cmd) => cmd.keys.includes('c'))?.name).toBe('Claude');
  });

  it('previews the draft itself, not the stored edit, for the shortcut being edited', () => {
    // `applyEdit` on top of the draft would put the saved URL back over the one
    // being typed.
    const draft: Command = { ...github, id: 'gh', url: 'https://half.typed' };
    const commands = previewCommands(
      registry,
      { ...DEFAULT_OVERRIDES, edits: { gh: { url: 'https://saved.example' } } },
      draft,
      'gh',
      true,
    );
    expect(commands.find((cmd) => cmd.id === 'gh')?.url).toBe('https://half.typed');
  });

  it('previews a switched-off shipped shortcut as if it were on', () => {
    const draft: Command = { ...github, id: 'gh' };
    const commands = previewCommands(
      registry,
      { ...DEFAULT_OVERRIDES, disabled: ['gh'] },
      draft,
      'gh',
      true,
    );
    expect(commands.some((cmd) => cmd.id === 'gh')).toBe(true);
  });

  it('splices a user shortcut into custom, where it shadows the builtins', () => {
    const draft: Command = {
      id: 'u:x',
      keys: ['gh'],
      name: 'My hub',
      description: '',
      url: 'https://example.com',
      category: 'custom',
      builtin: false,
    };
    const stored: Command = { ...draft, keys: ['hub'], name: 'Old' };
    const commands = previewCommands(
      registry,
      { ...DEFAULT_OVERRIDES, custom: [stored] },
      draft,
      'u:x',
      false,
    );
    expect(commands[0]?.name).toBe('My hub');
    expect(commands.filter((cmd) => cmd.id === 'u:x')).toHaveLength(1);
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

describe('findEntry', () => {
  const entries: Entry[] = [
    { id: 'u:gh', matchKey: 'gh', cmd: { ...github, id: 'u:gh', builtin: false }, shipped: false, disabled: false, modified: false },
    { id: 'gh', matchKey: 'gh', cmd: { ...github, id: 'gh' }, shipped: true, disabled: false, modified: false },
  ];
  const route = (query: string): URLSearchParams => new URLSearchParams(query);

  it('resolves ?id= by id', () => {
    expect(findEntry(entries, route('id=gh'))?.shipped).toBe(true);
    expect(findEntry(entries, route('id=u:gh'))?.shipped).toBe(false);
  });

  it('normalises the id, so a hand-typed one still finds its row', () => {
    expect(findEntry(entries, route('id=U%3AGH'))?.id).toBe('u:gh');
  });

  it('runs the ALIAS pass first for the legacy ?key=', () => {
    // `?key=gh` names whatever `gh` opens NOW, and the user's own `gh` shadows
    // the builtin (invariant 10). Trying the id first opened the builtin: the
    // one the address bar does not go to.
    expect(findEntry(entries, route('key=gh'))?.id).toBe('u:gh');
  });

  it('still reads ?key= as an id, which is what it carried before ids existed', () => {
    expect(findEntry(entries, route('key=u:gh'))?.id).toBe('u:gh');
  });

  it('finds nothing for a deleted or unknown shortcut', () => {
    // The caller turns this into a notice and a bounce to the list rather than
    // a blank New form under an "Edit" heading.
    expect(findEntry(entries, route('id=gone'))).toBeUndefined();
    expect(findEntry(entries, route(''))).toBeUndefined();
  });
});
