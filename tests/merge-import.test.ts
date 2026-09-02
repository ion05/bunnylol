/**
 * The import merge plan.
 *
 * Two properties are worth more than the rest: nothing already here changes
 * value, and nothing in the file is lost. Everything else — the renames, the
 * re-mints, the section suffixes — is machinery in service of holding both at
 * once, and the reported fields exist so the confirmation dialog can only
 * promise what the merge actually does.
 */

import { describe, expect, it } from 'vitest';
import { mergeOverrides, signatureOf } from '../src/lib/merge-import';
import { MAX_SECTIONS, sectionLabel, shortcutId } from '../src/lib/overrides';
import { exportJson } from '../src/lib/storage';
import { MAX_SECTION_ID_LENGTH } from '../src/lib/validate';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS } from '../src/lib/types';
import type { Command, Overrides, StoredState } from '../src/lib/types';

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
    expect(plan.added[0].keys).toEqual(['gh2']);
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

  it('re-mints an incoming id that is already taken', () => {
    const plan = mergeOverrides(
      overrides({ custom: [cmd({ id: 'u:tix' })] }),
      overrides({ custom: [cmd({ id: 'u:tix', keys: ['pay'], url: 'https://pay.example/' })] }),
    );
    // Two shortcuts on one id would share its `edits` and `disabled` entries,
    // and the second would inherit the first's history.
    expect(plan.added[0].id).toBe('u:pay');
    expect(new Set(plan.overrides.custom.map(shortcutId)).size).toBe(2);
  });

  it('mints an id for an incoming shortcut that has none', () => {
    const plan = mergeOverrides(
      overrides(),
      overrides({ custom: [cmd({ keys: ['pay'], url: 'https://pay.example/' })] }),
    );
    expect(plan.added[0].id).toBe('u:pay');
  });

  it('nothing is lost: every incoming shortcut or an equivalent is present after merge', () => {
    const incoming = overrides({
      custom: [
        cmd({ id: 'u:tix', keys: ['tix'] }),
        cmd({ id: 'u:tix', keys: ['tix'], url: 'https://other.example/' }),
        cmd({ keys: ['pay'], url: 'https://pay.example/' }),
      ],
    });
    const plan = mergeOverrides(overrides({ custom: [cmd({ id: 'u:mine', keys: ['mine'] })] }), incoming);
    expect(plan.overrides.custom.length).toBe(4);
    const ids = plan.overrides.custom.map(shortcutId);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = plan.overrides.custom.flatMap((entry) => entry.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('mergeOverrides edits', () => {
  it('ours win per field on a collision, and the field is not reported', () => {
    const plan = mergeOverrides(
      overrides({ edits: { gh: { name: 'Mine' } } }),
      overrides({ edits: { gh: { name: 'Theirs', description: 'Also theirs' } } }),
    );
    expect(plan.overrides.edits.gh).toEqual({ name: 'Mine', description: 'Also theirs' });
    // The description IS a change of theirs, so it is reported; the name is not.
    expect(plan.edits).toEqual(['gh']);
  });

  it('says nothing when the incoming entry contributes nothing', () => {
    const plan = mergeOverrides(
      overrides({ edits: { gh: { name: 'Mine' } } }),
      overrides({ edits: { gh: { name: 'Theirs' } } }),
    );
    expect(plan.overrides.edits.gh).toEqual({ name: 'Mine' });
    expect(plan.edits).toEqual([]);
    expect(plan.rebinds).toEqual([]);
  });

  it('reports an incoming edit we do not have', () => {
    const plan = mergeOverrides(overrides(), overrides({ edits: { gh: { name: 'Theirs' } } }));
    expect(plan.edits).toEqual(['gh']);
    expect(plan.overrides.edits.gh).toEqual({ name: 'Theirs' });
  });

  it('reports a keys-carrying edit as a rebind and not twice', () => {
    const plan = mergeOverrides(overrides(), overrides({ edits: { gh: { keys: ['hub'] } } }));
    expect(plan.rebinds).toEqual(['gh']);
    expect(plan.edits).toEqual([]);
  });

  it('reports a rebind that arrives alongside another change under both headings', () => {
    const plan = mergeOverrides(
      overrides(),
      overrides({ edits: { gh: { keys: ['hub'], name: 'Hub' } } }),
    );
    expect(plan.rebinds).toEqual(['gh']);
    expect(plan.edits).toEqual(['gh']);
  });

  it('keeps the edits map free of a prototype', () => {
    const plan = mergeOverrides(overrides(), overrides());
    expect(Object.getPrototypeOf(plan.overrides.edits)).toBeNull();
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

  it('reports nothing when the file turns off only what is already off', () => {
    const plan = mergeOverrides(
      overrides({ disabled: ['gh'], deleted: ['npm'] }),
      overrides({ disabled: ['gh'], deleted: ['npm'] }),
    );
    expect(plan.disables).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it('follows a re-minted shortcut instead of switching ours off in its place', () => {
    // Both profiles minted `u:jira` for their own Jira. Unioned as written, the
    // file's "u:jira is off" lands on OURS and leaves theirs on — the merge
    // silently switching off a shortcut the dialog never named.
    const plan = mergeOverrides(
      overrides({ custom: [cmd({ id: 'u:jira', keys: ['jira'], url: 'https://ours.example/' })] }),
      overrides({
        custom: [cmd({ id: 'u:jira', keys: ['jira'], url: 'https://theirs.example/' })],
        disabled: ['u:jira'],
        deleted: ['u:jira'],
      }),
    );
    expect(plan.added[0].id).toBe('u:jira-2');
    expect(plan.overrides.disabled).toEqual(['u:jira-2']);
    expect(plan.overrides.deleted).toEqual(['u:jira-2']);
    expect(plan.disables).toEqual(['u:jira-2']);
    expect(plan.deletes).toEqual(['u:jira-2']);
  });

  it('follows a skipped duplicate onto the twin of ours that survived', () => {
    // Their `u:jira` is identical to our `u:mine`, so it is not added — but the
    // file still has something to say about that shortcut, and `u:jira` here
    // names an unrelated one of ours.
    const plan = mergeOverrides(
      overrides({
        custom: [
          cmd({ id: 'u:mine', keys: ['jira'], url: 'https://shared.example/' }),
          cmd({ id: 'u:jira', keys: ['other'], url: 'https://other.example/' }),
        ],
      }),
      overrides({
        custom: [cmd({ id: 'u:jira', keys: ['jira'], url: 'https://shared.example/' })],
        disabled: ['u:jira'],
      }),
    );
    expect(plan.duplicates).toEqual(['jira']);
    expect(plan.overrides.disabled).toEqual(['u:mine']);
  });
});

describe('mergeOverrides sections', () => {
  it('unions sections and keeps our label on a conflict', () => {
    const plan = mergeOverrides(
      overrides({ sections: [{ id: 'sec-work', label: 'Work' }] }),
      overrides({
        sections: [
          { id: 'sec-work', label: 'work' },
          { id: 'sec-pay', label: 'Billing' },
        ],
      }),
    );
    expect(plan.overrides.sections).toEqual([
      { id: 'sec-work', label: 'Work' },
      { id: 'sec-pay', label: 'Billing' },
    ]);
    expect(plan.sections).toEqual([{ id: 'sec-pay', label: 'Billing' }]);
  });

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
    expect(plan.added[0].category).toBe('sec-work-2');
    expect(plan.overrides.edits.gh).toEqual({ category: 'sec-work-2' });
  });

  it('keeps suffixing until the id is free', () => {
    const plan = mergeOverrides(
      overrides({
        sections: [
          { id: 'sec-work', label: 'Work' },
          { id: 'sec-work-2', label: 'Second' },
        ],
      }),
      overrides({ sections: [{ id: 'sec-work', label: 'Client work' }] }),
    );
    expect(plan.sections).toEqual([{ id: 'sec-work-3', label: 'Client work' }]);
  });

  it('treats a shipped id with a different label as a collision', () => {
    // We never renamed Developer, so there is no `sections` entry to clash
    // with — and adding theirs verbatim would rename a shipped group under the
    // heading "adds 1 section".
    const plan = mergeOverrides(
      overrides(),
      overrides({
        sections: [{ id: 'dev', label: 'Engineering' }],
        edits: { gh: { category: 'dev' } },
        custom: [cmd({ id: 'u:pay', keys: ['pay'], category: 'dev' })],
      }),
    );
    expect(plan.overrides.sections).toEqual([{ id: 'dev-2', label: 'Engineering' }]);
    expect(plan.sections).toEqual([{ id: 'dev-2', label: 'Engineering' }]);
    expect(plan.added[0].category).toBe('dev-2');
    expect(plan.overrides.edits.gh).toEqual({ category: 'dev-2' });
    // Ours keeps the shipped name.
    expect(sectionLabel('dev', plan.overrides.sections)).toBe('Developer');
  });

  it('adds nothing when a shipped id arrives under the label it already has', () => {
    const plan = mergeOverrides(overrides(), overrides({ sections: [{ id: 'dev', label: 'Developer' }] }));
    expect(plan.overrides.sections).toEqual([]);
    expect(plan.sections).toEqual([]);
  });

  it('adds nothing when a shipped id arrives under the label WE renamed it to', () => {
    const ours = [{ id: 'dev', label: 'Engineering' }];
    const plan = mergeOverrides(
      overrides({ sections: ours }),
      overrides({ sections: [{ id: 'dev', label: 'engineering' }] }),
    );
    expect(plan.overrides.sections).toEqual(ours);
    expect(plan.sections).toEqual([]);
  });

  it('keeps a suffixed id inside the length cap the save enforces', () => {
    // `<id>-2` on a 32-character id is a 34-character one, which
    // `validateSectionId` rejects and `normalizeSections` drops on the next
    // save — taking every shortcut filed under it back to My shortcuts.
    const long = 'a'.repeat(MAX_SECTION_ID_LENGTH);
    const plan = mergeOverrides(
      overrides({ sections: [{ id: long, label: 'Ours' }] }),
      overrides({
        sections: [{ id: long, label: 'Theirs' }],
        custom: [cmd({ id: 'u:pay', keys: ['pay'], category: long })],
      }),
    );
    const refiled = plan.sections[0].id;
    expect(refiled.length).toBeLessThanOrEqual(MAX_SECTION_ID_LENGTH);
    expect(plan.added[0].category).toBe(refiled);
    // Through the real storage boundary: the section survives the save and the
    // shortcut is still in it.
    const saved = JSON.parse(
      exportJson({ overrides: plan.overrides, settings: DEFAULT_SETTINGS }),
    ) as StoredState;
    expect(saved.overrides.sections.map((section) => section.id)).toEqual([long, refiled]);
    expect(saved.overrides.custom[0].category).toBe(refiled);
  });

  it('stops adding at MAX_SECTIONS and reports what it left out', () => {
    const full = Array.from({ length: MAX_SECTIONS }, (_, n) => ({
      id: `sec-ours-${n}`,
      label: `Ours ${n}`,
    }));
    const plan = mergeOverrides(
      overrides({ sections: full }),
      overrides({ sections: [{ id: 'sec-theirs', label: 'Theirs' }] }),
    );
    expect(plan.overrides.sections).toEqual(full);
    expect(plan.sections).toEqual([]);
    expect(plan.sectionsRefused).toEqual([{ id: 'sec-theirs', label: 'Theirs' }]);
  });

  it('takes what fits at the cap and refuses only the rest', () => {
    const nearly = Array.from({ length: MAX_SECTIONS - 1 }, (_, n) => ({
      id: `sec-ours-${n}`,
      label: `Ours ${n}`,
    }));
    const plan = mergeOverrides(
      overrides({ sections: nearly }),
      overrides({
        sections: [
          { id: 'sec-first', label: 'First' },
          { id: 'sec-second', label: 'Second' },
        ],
      }),
    );
    expect(plan.overrides.sections.length).toBe(MAX_SECTIONS);
    expect(plan.sections).toEqual([{ id: 'sec-first', label: 'First' }]);
    expect(plan.sectionsRefused).toEqual([{ id: 'sec-second', label: 'Second' }]);
    // Nothing the save would drop is emitted, so what the dialog names and what
    // the browse list shows are the same list.
    const saved = JSON.parse(
      exportJson({ overrides: plan.overrides, settings: DEFAULT_SETTINGS }),
    ) as StoredState;
    expect(saved.overrides.sections.length).toBe(MAX_SECTIONS);
  });

  it('leaves a member of a section that did not move where it was', () => {
    const plan = mergeOverrides(
      overrides(),
      overrides({
        sections: [{ id: 'sec-work', label: 'Work' }],
        custom: [cmd({ id: 'u:pay', keys: ['pay'], category: 'sec-work' })],
      }),
    );
    expect(plan.added[0].category).toBe('sec-work');
    expect(plan.sections).toEqual([{ id: 'sec-work', label: 'Work' }]);
  });
});

describe('mergeOverrides onboarding fields', () => {
  it('keeps our pick', () => {
    const plan = mergeOverrides(
      overrides({ enabledCategories: ['dev'] }),
      overrides({ enabledCategories: ['purdue'] }),
    );
    expect(plan.overrides.enabledCategories).toEqual(['dev']);
    expect(plan.enabledCategories).toBeUndefined();
  });

  it('adopts the file\'s pick only when we never made one', () => {
    const plan = mergeOverrides(overrides(), overrides({ enabledCategories: ['purdue'] }));
    expect(plan.overrides.enabledCategories).toEqual(['purdue']);
    expect(plan.enabledCategories).toEqual(['purdue']);
  });

  it('stays un-onboarded when neither side has a pick', () => {
    const plan = mergeOverrides(overrides(), overrides());
    expect(plan.overrides.enabledCategories).toBeNull();
    expect(plan.enabledCategories).toBeUndefined();
  });

  it('unions seenBuiltins', () => {
    const plan = mergeOverrides(
      overrides({ seenBuiltins: ['gh'] }),
      overrides({ seenBuiltins: ['gh', 'npm'] }),
    );
    expect(plan.overrides.seenBuiltins).toEqual(['gh', 'npm']);
  });
});

describe('mergeOverrides purity', () => {
  it('does not mutate either side', () => {
    const current = overrides({
      disabled: ['gh'],
      edits: { gh: { name: 'Mine' } },
      sections: [{ id: 'sec-work', label: 'Work' }],
      custom: [cmd({ id: 'u:tix' })],
    });
    const incoming = overrides({
      deleted: ['npm'],
      edits: { gh: { keys: ['hub'] } },
      sections: [{ id: 'sec-work', label: 'Client work' }],
      custom: [cmd({ id: 'u:tix', keys: ['pay'], category: 'sec-work' })],
    });
    const before = [JSON.stringify(current), JSON.stringify(incoming)];
    mergeOverrides(current, incoming);
    expect([JSON.stringify(current), JSON.stringify(incoming)]).toEqual(before);
  });
});

describe('signatureOf', () => {
  it('ignores the fields a rename touches', () => {
    expect(signatureOf(cmd({ name: 'A' }))).toBe(signatureOf(cmd({ name: 'B' })));
    expect(signatureOf(cmd({ description: 'A' }))).toBe(signatureOf(cmd({ description: 'B' })));
    expect(signatureOf(cmd({ keys: ['a'] }))).toBe(signatureOf(cmd({ keys: ['b'] })));
  });

  it('separates two shortcuts that go somewhere different', () => {
    expect(signatureOf(cmd({}))).not.toBe(signatureOf(cmd({ url: 'https://other.example/' })));
    expect(signatureOf(cmd({}))).not.toBe(
      signatureOf(cmd({ searchUrl: 'https://tix.example/?q={q}' })),
    );
    expect(signatureOf(cmd({}))).not.toBe(signatureOf(cmd({ handler: 'github' })));
  });

  it('cannot be fooled by a field boundary', () => {
    // The separator is a NUL, which no url or handler id contains, so
    // `url: 'a', searchUrl: 'b'` and `url: 'ab'` stay distinguishable.
    expect(signatureOf(cmd({ url: 'https://a.example/', searchUrl: 'https://b.example/' }))).not.toBe(
      signatureOf(cmd({ url: 'https://a.example/https://b.example/' })),
    );
  });
});
