/**
 * `src/options/model/browse.ts` is the browse list's grouping and filtering
 * logic, pulled out of `options.ts` so it can be exercised without a DOM.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`, which is only true if the module touches neither
 * `document` nor `chrome.*` at module scope.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { restorableShipped, sectionKey, shortcutId } from '../src/lib/overrides';
import { mergeCommands } from '../src/lib/resolve';
import { validateSectionId } from '../src/lib/validate';
import { DEFAULT_OVERRIDES } from '../src/lib/types';
import type { BuiltinCommand, Command, Overrides } from '../src/lib/types';
import {
  browseEntries,
  browseGroups,
  buildKeyOwner,
  countLabel,
  exampleOf,
  haystackOf,
  HIDDEN_GROUP_ID,
} from '../src/options/model/browse';

const github: BuiltinCommand = {
  keys: ['gh', 'github'],
  name: 'GitHub',
  description: 'Open a repo, or search GitHub.',
  url: 'https://github.com',
  searchUrl: 'https://github.com/search?q={q}',
  category: 'dev',
  builtin: true,
};

const reddit: BuiltinCommand = {
  keys: ['r'],
  name: 'Reddit',
  description: 'Open a subreddit.',
  url: 'https://reddit.com',
  category: 'social',
  builtin: true,
};

const builtins: BuiltinCommand[] = [github, reddit];

function overridesWith(patch: Partial<Overrides>): Overrides {
  return { ...DEFAULT_OVERRIDES, ...patch };
}

const ticket: Command = {
  id: 'u:tix',
  keys: ['tix'],
  name: 'Tickets',
  description: 'Buy tickets.',
  url: 'https://example.com',
  category: 'custom',
  builtin: false,
};

describe('browseEntries', () => {
  it('lists every builtin plus every custom command', () => {
    const entries = browseEntries(builtins, overridesWith({ custom: [ticket] }));
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.cmd.name).sort()).toEqual(['GitHub', 'Reddit', 'Tickets']);
  });

  it('a custom command comes before the builtins', () => {
    const entries = browseEntries(builtins, overridesWith({ custom: [ticket] }));
    expect(entries[0].cmd.name).toBe('Tickets');
  });

  it('a disabled builtin is still an entry, marked disabled', () => {
    const entries = browseEntries(builtins, overridesWith({ disabled: ['gh'] }));
    const entry = entries.find((candidate) => candidate.id === 'gh');
    expect(entry).toBeDefined();
    expect(entry?.disabled).toBe(true);
    expect(entry?.cmd.name).toBe('GitHub');
  });

  it('a deleted builtin is missing entirely', () => {
    const entries = browseEntries(builtins, overridesWith({ deleted: ['r'] }));
    expect(entries.some((entry) => entry.id === 'r')).toBe(false);
  });

  it('matchKey follows the override, not the shipped key', () => {
    const entries = browseEntries(builtins, overridesWith({ edits: { gh: { keys: ['git'] } } }));
    const entry = entries.find((candidate) => candidate.id === 'gh');
    expect(entry?.matchKey).toBe('git');
  });

  it('an edited builtin entry carries the edit and is marked modified', () => {
    const entries = browseEntries(
      builtins,
      overridesWith({ edits: { gh: { name: 'Hub', example: 'gh facebook/react' } } }),
    );
    const entry = entries.find((candidate) => candidate.id === 'gh');
    expect(entry?.cmd.name).toBe('Hub');
    expect(entry?.cmd.example).toBe('gh facebook/react');
    expect(entry?.modified).toBe(true);
    expect(entry?.shipped).toBe(true);
  });

  it('an unedited builtin entry is not marked modified', () => {
    const entries = browseEntries(builtins, DEFAULT_OVERRIDES);
    expect(entries.every((entry) => entry.modified)).toBe(false);
    expect(entries.find((entry) => entry.id === 'gh')?.modified).toBe(false);
  });

  it('an edit that changes nothing is not a modification', () => {
    // Representable, and it survives storage: an import can carry an `edits`
    // entry that restates the shipped values, and an empty object is an edit
    // too. The badge has to mean "different from shipped", because Reset then
    // Save writes the diff, which is empty, and could never clear it.
    for (const edit of [{}, { name: 'GitHub' }, { keys: ['gh', 'github'] }, { category: 'dev' }]) {
      const entries = browseEntries(builtins, overridesWith({ edits: { gh: edit } }));
      expect(
        entries.find((candidate) => candidate.id === 'gh')?.modified,
        JSON.stringify(edit),
      ).toBe(false);
    }
  });

  it('a custom entry is shipped: false and never modified', () => {
    // A custom command is edited in place, so it has nothing to differ FROM;
    // the badge would be claiming a difference the user cannot go and look at.
    const entries = browseEntries(builtins, overridesWith({ custom: [ticket] }));
    const entry = entries.find((candidate) => candidate.id === 'u:tix');
    expect(entry?.shipped).toBe(false);
    expect(entry?.modified).toBe(false);
  });

  it('a disabled custom command is still an entry, marked disabled', () => {
    const entries = browseEntries(
      builtins,
      overridesWith({ custom: [ticket], disabled: ['u:tix'] }),
    );
    const entry = entries.find((candidate) => candidate.id === 'u:tix');
    expect(entry).toBeDefined();
    expect(entry?.disabled).toBe(true);
  });

  it('deleting a builtin removes it from disabled but keeps its edit', () => {
    // What the row's Delete handler writes: a deleted shortcut is gone rather
    // than off, and Restore has to bring back the version the user had.
    const overrides = overridesWith({
      deleted: ['gh'],
      disabled: [],
      edits: { gh: { name: 'Hub' } },
    });
    expect(browseEntries(builtins, overrides).some((entry) => entry.id === 'gh')).toBe(false);
    expect(overrides.disabled).not.toContain('gh');
    expect(overrides.edits.gh).toEqual({ name: 'Hub' });
  });

  it('deleted shipped shortcuts are absent from browse entries and present in restorableShipped', () => {
    const overrides = overridesWith({ deleted: ['gh'], custom: [ticket] });
    const entries = browseEntries(builtins, overrides);
    expect(entries.some((entry) => entry.id === 'gh')).toBe(false);
    expect(entries.some((entry) => entry.id === 'r')).toBe(true);
    expect(restorableShipped(builtins, overrides).map(shortcutId)).toEqual(['gh']);
    // A custom command is deleted by removing it from `custom`, so it is never
    // offered for restore: there would be nothing to restore it from.
    expect(restorableShipped(builtins, overridesWith({ deleted: ['u:tix'] }))).toEqual([]);
  });

  it('browseEntries and mergeCommands agree on every enabled builtin', () => {
    // The drift guard between the list and the resolver, run against the real
    // registry: a row that claims a keyword, name or destination the resolver
    // does not answer to is worse than no row at all.
    const overrides = overridesWith({
      custom: [ticket],
      disabled: ['r'],
      deleted: ['gh'],
      sections: [{ id: 'sec-work', label: 'Client work' }],
      edits: {
        c: { name: 'Claude 5', keys: ['cl', 'claude'], category: 'sec-work' },
        g: { searchUrl: 'https://kagi.com/search?q={q}', description: 'Search Kagi.' },
      },
    });
    const merged = new Map(
      mergeCommands(BUILTIN_COMMANDS, overrides).map((cmd) => [shortcutId(cmd), cmd] as const),
    );
    const listed = browseEntries(BUILTIN_COMMANDS, overrides).filter((entry) => !entry.disabled);

    expect(listed.length).toBe(merged.size);
    for (const entry of listed) {
      const cmd = merged.get(entry.id);
      expect(cmd, `${entry.id} is listed but not merged`).toBeDefined();
      expect(cmd?.keys).toEqual(entry.cmd.keys);
      expect(cmd?.name).toBe(entry.cmd.name);
      expect(cmd?.description).toBe(entry.cmd.description);
      expect(cmd?.url).toBe(entry.cmd.url);
      expect(cmd?.searchUrl).toBe(entry.cmd.searchUrl);
      expect(cmd?.category).toBe(entry.cmd.category);
      expect(cmd?.example).toBe(entry.cmd.example);
      // The fields an edit may never move (invariant 16).
      expect(cmd?.handler).toBe(entry.cmd.handler);
      expect(cmd?.provider).toBe(entry.cmd.provider);
    }
  });
});

describe('haystackOf', () => {
  it('covers keys, name, description, url and searchUrl, lowercased', () => {
    const haystack = haystackOf(github);
    expect(haystack).toContain('gh');
    expect(haystack).toContain('github');
    expect(haystack).toContain('open a repo');
    expect(haystack).toContain('github.com');
    expect(haystack).toContain('search?q={q}');
    expect(haystack).toBe(haystack.toLowerCase());
  });
});

describe('exampleOf', () => {
  it('prefers the persisted example', () => {
    const withExample: Command = { ...ticket, example: 'tix concert' };
    expect(exampleOf(withExample)).toBe('tix concert');
  });

  it('derives one only for a non-builtin with a searchUrl', () => {
    const withSearch: Command = { ...ticket, searchUrl: 'https://example.com/search?q={q}' };
    expect(exampleOf(withSearch)).toBe('tix <arguments>');
    // A builtin never gets a derived example, even with a searchUrl.
    expect(exampleOf(github)).toBe('');
    // No searchUrl -> no derived example either.
    expect(exampleOf(ticket)).toBe('');
  });
});

describe('buildKeyOwner', () => {
  it('is first-writer-wins', () => {
    // `tix` clashes with nothing here, but a custom command sharing a builtin's
    // alias is listed first by `browseEntries`, so it wins the map.
    const clashing: Command = { ...ticket, keys: ['gh'] };
    const entries = browseEntries(builtins, overridesWith({ custom: [clashing] }));
    const owners = buildKeyOwner(entries);
    expect(owners.get('gh')).toBe('u:tix');
  });

  it('skips disabled entries', () => {
    const entries = browseEntries(builtins, overridesWith({ disabled: ['r'] }));
    const owners = buildKeyOwner(entries);
    expect(owners.has('r')).toBe(false);
  });
});

describe('browseGroups', () => {
  const sections = [{ id: 'sec-work', label: 'Client work' }];

  it('lists the sections that hold something, in page order, with their labels', () => {
    const groups = browseGroups(browseEntries(builtins, overridesWith({ custom: [ticket] })), []);
    expect(groups.map((group) => group.id)).toEqual(['custom', 'dev', 'social']);
    expect(groups.map((group) => group.label)).toEqual(['My shortcuts', 'Developer', 'Social']);
  });

  it('files every entry under exactly one group', () => {
    const entries = browseEntries(builtins, overridesWith({ custom: [ticket] }));
    const filed = browseGroups(entries, []).flatMap((group) => group.entries);
    expect(filed.map((entry) => entry.id).sort()).toEqual(entries.map((entry) => entry.id).sort());
  });

  it('keeps a switched-off entry filed under its own section', () => {
    // The hidden group draws it, but the section is where switching it back on
    // has to return it, and the view learns that from here.
    const entries = browseEntries(builtins, overridesWith({ disabled: ['gh'] }));
    const dev = browseGroups(entries, []).find((group) => group.id === 'dev');
    expect(dev?.entries.map((entry) => entry.id)).toEqual(['gh']);
  });

  it('keeps a section whose shortcuts are all off, and drops one holding nothing', () => {
    // A declined pack leaves its section empty on screen, and `applyFilter`
    // hides the heading. Dropping the group here instead would leave the rows
    // it owns with nowhere to go back to.
    const entries = browseEntries(builtins, overridesWith({ disabled: ['gh'], sections }));
    const ids = browseGroups(entries, sections).map((group) => group.id);
    expect(ids).toContain('dev');
    expect(ids).not.toContain('sec-work');
  });
});

describe('HIDDEN_GROUP_ID', () => {
  it('is an id the section editor could never mint', () => {
    // The fold of "Hidden shortcuts" shares one localStorage set with the real
    // sections, so a user-mintable key would let a section called "Hidden"
    // inherit this group's fold.
    expect(validateSectionId(HIDDEN_GROUP_ID).ok).toBe(false);
    // And it still survives the reader every fold is compared through.
    expect(sectionKey(HIDDEN_GROUP_ID)).toBe(HIDDEN_GROUP_ID);
  });
});

describe('countLabel', () => {
  it('counts shortcuts when nothing is off and no query is live', () => {
    expect(countLabel({ on: 170, shown: 170, total: 170 }, false)).toBe('170 shortcuts');
  });

  it('counts what is on when some are off', () => {
    expect(countLabel({ on: 96, shown: 170, total: 170 }, false)).toBe('96 of 170 shortcuts on');
  });

  it('keeps meaning matched out of all while a query is live', () => {
    expect(countLabel({ on: 4, shown: 4, total: 170 }, true)).toBe('4 of 170 shortcuts');
  });

  it('adds what is on as its own clause, so the two pairs cannot be confused', () => {
    // Without the clause this would read "2 of 170 shortcuts" for four matches,
    // or claim four live ones when two of them are switched off.
    expect(countLabel({ on: 2, shown: 4, total: 170 }, true)).toBe('4 of 170 shortcuts, 2 on');
  });

  it('says nothing extra when a query matches nothing', () => {
    expect(countLabel({ on: 0, shown: 0, total: 170 }, true)).toBe('0 of 170 shortcuts');
  });

  it('says none are on when every match is under Hidden shortcuts', () => {
    // A query for a declined pack's keyword: the rows are found, and the line
    // has to say that none of what it found is live.
    expect(countLabel({ on: 0, shown: 3, total: 170 }, true)).toBe('3 of 170 shortcuts, 0 on');
  });
});
