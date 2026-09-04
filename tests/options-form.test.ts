/**
 * `src/options/model/form.ts` is the add/edit form's validation and
 * command-building, kept out of `views/form.ts` so it can be exercised without
 * a DOM. Importing the module at all is half the test: it must load under
 * vitest's `environment: 'node'`.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT } from '../src/lib/draft';
import { DEFAULT_OVERRIDES } from '../src/lib/types';
import type { BuiltinCommand, Command } from '../src/lib/types';
import type { Entry } from '../src/options/model/browse';
import { previewCommands, validateDraft } from '../src/options/model/form';
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

  it('requires a destination URL', () => {
    const problems = validateDraft({ ...EMPTY_DRAFT, keys: 'x' }, emptyCtx);
    expect(
      problems.some(
        (problem) =>
          problem.level === 'error' && problem.field === 'url' && problem.text.includes('required'),
      ),
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
});

describe('findEntry', () => {
  const entries: Entry[] = [
    {
      id: 'u:gh',
      matchKey: 'gh',
      cmd: { ...github, id: 'u:gh', builtin: false },
      shipped: false,
      disabled: false,
      modified: false,
    },
    {
      id: 'gh',
      matchKey: 'gh',
      cmd: { ...github, id: 'gh' },
      shipped: true,
      disabled: false,
      modified: false,
    },
  ];
  const route = (query: string): URLSearchParams => new URLSearchParams(query);

  it('resolves ?id= by id', () => {
    expect(findEntry(entries, route('id=gh'))?.shipped).toBe(true);
    expect(findEntry(entries, route('id=u:gh'))?.shipped).toBe(false);
  });
});
