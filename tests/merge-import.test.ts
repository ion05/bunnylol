/**
 * The import merge plan.
 *
 * Two properties are worth more than the rest: nothing already here changes
 * value, and nothing in the file is lost. Everything else is machinery in
 * service of holding both at once: the renames, the re-mints, the section
 * suffixes. The reported fields exist so the confirmation dialog can only
 * promise what the merge actually does.
 */

import { describe, expect, it } from 'vitest';
import { at } from './helpers/at';
import { mergeOverrides } from '../src/lib/merge-import';
import { DEFAULT_OVERRIDES } from '../src/lib/types';
import type { Command, Overrides } from '../src/lib/types';

function cmd(patch: Partial<Command>): Command {
  return {
    keys: ['tix'],
    name: 'Tickets',
    description: '',
    url: 'https://tix.example/',
    category: 'custom',
    builtin: false,
    ...patch,
  };
}

function overrides(patch: Partial<Overrides> = {}): Overrides {
  return { ...DEFAULT_OVERRIDES, ...patch };
}

describe('mergeOverrides custom commands', () => {
  it('appends incoming shortcuts and reports them', () => {
    const plan = mergeOverrides(
      overrides({ custom: [cmd({ id: 'u:tix' })] }),
      overrides({ custom: [cmd({ id: 'u:pay', keys: ['pay'], url: 'https://pay.example/' })] }),
    );
    expect(plan.added.map((entry) => entry.keys[0])).toEqual(['pay']);
    expect(plan.overrides.custom.map((entry) => entry.keys[0])).toEqual(['tix', 'pay']);
  });

  it('renames an incoming alias that is already taken and reports the rename', () => {
    const plan = mergeOverrides(
      overrides({ custom: [cmd({ id: 'u:gh', keys: ['gh'] })] }),
      overrides({ custom: [cmd({ id: 'u:hub', keys: ['gh'], url: 'https://hub.example/' })] }),
    );
    expect(plan.renames).toEqual([{ from: 'gh', to: 'gh2' }]);
    expect(at(plan.added, 0).keys).toEqual(['gh2']);
  });

  it('skips an incoming shortcut identical to one of ours', () => {
    const mine = cmd({ id: 'u:tix' });
    const plan = mergeOverrides(
      overrides({ custom: [mine] }),
      overrides({ custom: [cmd({ id: 'u:theirs', name: 'Their name for it' })] }),
    );
    expect(plan.duplicates).toEqual(['tix']);
    expect(plan.added).toEqual([]);
    expect(plan.overrides.custom).toEqual([mine]);
  });
});

describe('mergeOverrides edits', () => {
  it('says nothing when the incoming entry contributes nothing', () => {
    const plan = mergeOverrides(
      overrides({ edits: { gh: { name: 'Mine' } } }),
      overrides({ edits: { gh: { name: 'Theirs' } } }),
    );
    expect(plan.overrides.edits.gh).toEqual({ name: 'Mine' });
    expect(plan.edits).toEqual([]);
    expect(plan.rebinds).toEqual([]);
  });
});

describe('mergeOverrides disabled and deleted', () => {
  it('unions both and reports only what changes', () => {
    const plan = mergeOverrides(
      overrides({ disabled: ['gh'], deleted: ['npm'] }),
      overrides({ disabled: ['gh', 'g'], deleted: ['npm', 'lh'] }),
    );
    expect(plan.overrides.disabled).toEqual(['gh', 'g']);
    expect(plan.overrides.deleted).toEqual(['npm', 'lh']);
    expect(plan.disables).toEqual(['g']);
    expect(plan.deletes).toEqual(['lh']);
  });

  it('follows a re-minted shortcut instead of switching ours off in its place', () => {
    // Both profiles minted `u:jira` for their own Jira. Unioned as written, the
    // file's "u:jira is off" lands on OURS and leaves theirs on: the merge
    // silently switching off a shortcut the dialog never named.
    const plan = mergeOverrides(
      overrides({ custom: [cmd({ id: 'u:jira', keys: ['jira'], url: 'https://ours.example/' })] }),
      overrides({
        custom: [cmd({ id: 'u:jira', keys: ['jira'], url: 'https://theirs.example/' })],
        disabled: ['u:jira'],
        deleted: ['u:jira'],
      }),
    );
    expect(at(plan.added, 0).id).toBe('u:jira-2');
    expect(plan.overrides.disabled).toEqual(['u:jira-2']);
    expect(plan.overrides.deleted).toEqual(['u:jira-2']);
    expect(plan.disables).toEqual(['u:jira-2']);
    expect(plan.deletes).toEqual(['u:jira-2']);
  });
});

describe('mergeOverrides sections', () => {
  it('renames a colliding incoming section and rewrites its members', () => {
    const plan = mergeOverrides(
      overrides({ sections: [{ id: 'sec-work', label: 'Work' }] }),
      overrides({
        sections: [{ id: 'sec-work', label: 'Client work' }],
        edits: { gh: { category: 'sec-work' } },
        custom: [cmd({ id: 'u:pay', keys: ['pay'], category: 'sec-work' })],
      }),
    );
    expect(plan.overrides.sections).toEqual([
      { id: 'sec-work', label: 'Work' },
      { id: 'sec-work-2', label: 'Client work' },
    ]);
    expect(plan.sections).toEqual([{ id: 'sec-work-2', label: 'Client work' }]);
    expect(at(plan.added, 0).category).toBe('sec-work-2');
    expect(plan.overrides.edits.gh).toEqual({ category: 'sec-work-2' });
  });
});
