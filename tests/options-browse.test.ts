/**
 * `src/options/model/browse.ts` is the browse list's grouping and filtering
 * logic, kept out of `views/browse.ts` so it can be exercised without a DOM.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`, which is only true if the module touches neither
 * `document` nor `chrome.*` at module scope.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_OVERRIDES } from '../src/lib/types';
import type { BuiltinCommand, Command, Overrides } from '../src/lib/types';
import { browseEntries, browseGroups, enableAll } from '../src/options/model/browse';

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

  it('a deleted builtin is missing entirely', () => {
    const entries = browseEntries(builtins, overridesWith({ deleted: ['r'] }));
    expect(entries.some((entry) => entry.id === 'r')).toBe(false);
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
});

describe('browseGroups', () => {
  it('files every entry under exactly one group', () => {
    const entries = browseEntries(builtins, overridesWith({ custom: [ticket] }));
    const filed = browseGroups(entries, []).flatMap((group) => group.entries);
    expect(filed.map((entry) => entry.id).sort()).toEqual(entries.map((entry) => entry.id).sort());
  });
});

describe('enableAll', () => {
  it('takes every id it is given out of disabled, in one list', () => {
    // One list, for one `commitOverrides` call: a write per row would be the
    // burst of `onStateChanged` events invariant 15 exists to survive.
    expect(enableAll(['gh', 'r', 'u:tix'], ['gh', 'u:tix'])).toEqual(['r']);
  });
});
