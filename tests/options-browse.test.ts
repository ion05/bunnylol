/**
 * `src/options/model/browse.ts` is the browse list's grouping and filtering
 * logic, pulled out of `options.ts` so it can be exercised without a DOM.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`, which is only true if the module touches neither
 * `document` nor `chrome.*` at module scope.
 */

import { describe, expect, it } from 'vitest';
import {
  browseEntries,
  buildKeyOwner,
  describeOwner,
  exampleOf,
  haystackOf,
} from '../src/options/model/browse';
import { DEFAULT_OVERRIDES } from '../src/lib/types';
import type { BuiltinCommand, Command, Overrides } from '../src/lib/types';

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

describe('describeOwner', () => {
  it('names an unknown id in quotes', () => {
    const entries = browseEntries(builtins, DEFAULT_OVERRIDES);
    expect(describeOwner(entries, 'ghost')).toBe('“ghost”');
  });

  it('names a known builtin as "built in" and a custom one as "your shortcut"', () => {
    const entries = browseEntries(builtins, overridesWith({ custom: [ticket] }));
    expect(describeOwner(entries, 'gh')).toBe('GitHub (built in)');
    expect(describeOwner(entries, 'u:tix')).toBe('Tickets (your shortcut)');
  });
});
