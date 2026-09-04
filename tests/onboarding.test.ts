/**
 * The onboarding pick, as data.
 *
 * Every case here is driven through `mergeCommands` wherever the question is
 * "what does the user end up with", because a pick that writes the right
 * `disabled` list and still resolves the wrong shortcuts is not a pick. The
 * projection onto `disabled` is the whole design: nothing downstream of it
 * knows what a category is.
 */

import { describe, expect, it } from 'vitest';
import {
  STARTER_CATEGORIES,
  applyCategoryPick,
  categoryPicks,
  migrateNewBuiltins,
} from '../src/lib/onboarding';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { buildKeyMap, mergeCommands } from '../src/lib/resolve';
import { shortcutId } from '../src/lib/overrides';
import { DEFAULT_OVERRIDES } from '../src/lib/types';
import type { BuiltinCommand, Overrides } from '../src/lib/types';

/** The ids the registry ships in a category: the answer a pick has to match. */
function idsIn(category: string): string[] {
  return BUILTIN_COMMANDS.filter((cmd) => cmd.category === category).map(shortcutId);
}

function keysOf(overrides: Overrides): Set<string> {
  return new Set(buildKeyMap(mergeCommands(BUILTIN_COMMANDS, overrides)).keys());
}

function builtin(patch: Partial<BuiltinCommand>): BuiltinCommand {
  return {
    keys: ['zz'],
    name: 'New',
    description: '',
    url: 'https://new.example/',
    category: 'dev',
    builtin: true,
    ...patch,
  };
}

describe('applyCategoryPick', () => {
  it('a fresh install pick disables every purdue command', () => {
    const next = applyCategoryPick(BUILTIN_COMMANDS, STARTER_CATEGORIES, DEFAULT_OVERRIDES);
    const purdue = idsIn('purdue');
    expect(purdue.length).toBeGreaterThan(0);
    for (const id of purdue) expect(next.disabled).toContain(id);
    // And not just in the list: the resolver cannot see them either.
    const keys = keysOf(next);
    expect(keys.has('bs')).toBe(false);
    expect(keys.has('gh')).toBe(true);
    expect(keys.has('g')).toBe(true);
    expect(keys.has('c')).toBe(true);
  });

  it('keeps the meta commands whether or not they were picked', () => {
    const next = applyCategoryPick(BUILTIN_COMMANDS, ['dev'], DEFAULT_OVERRIDES);
    for (const id of idsIn('meta')) expect(next.disabled).not.toContain(id);
    expect(keysOf(next).has('bl')).toBe(true);
    expect(next.enabledCategories).toEqual(['dev', 'meta']);
  });

  it('records the pick and marks every shipped id as seen', () => {
    const next = applyCategoryPick(BUILTIN_COMMANDS, ['dev'], DEFAULT_OVERRIDES);
    expect(new Set(next.seenBuiltins)).toEqual(new Set(BUILTIN_COMMANDS.map(shortcutId)));
  });

  it('does not touch deleted: a deleted shortcut stays deleted through a re-pick', () => {
    const deleted: Overrides = { ...DEFAULT_OVERRIDES, deleted: ['gh'] };
    const next = applyCategoryPick(BUILTIN_COMMANDS, ['dev'], deleted);
    expect(next.deleted).toEqual(['gh']);
    expect(keysOf(next).has('gh')).toBe(false);
  });
});

describe('migrateNewBuiltins', () => {
  const seeded = applyCategoryPick(BUILTIN_COMMANDS, ['dev'], DEFAULT_OVERRIDES);

  it('never disables anything when enabledCategories is null', () => {
    const migrated = migrateNewBuiltins(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);
    expect(migrated.enabledCategories).toBeNull();
    expect(migrated.disabled).toEqual([]);
    expect(migrated.seenBuiltins.length).toBe(BUILTIN_COMMANDS.length);
    expect(keysOf(migrated).has('bs')).toBe(true);
  });

  it('a new builtin in an unpicked category arrives disabled', () => {
    const registry: BuiltinCommand[] = [
      ...BUILTIN_COMMANDS,
      builtin({ keys: ['zz'], category: 'purdue' }),
    ];
    const migrated = migrateNewBuiltins(registry, seeded);
    expect(migrated.disabled).toContain('zz');
    expect(new Set(buildKeyMap(mergeCommands(registry, migrated)).keys()).has('zz')).toBe(false);
  });
});

describe('categoryPicks', () => {
  const rows = categoryPicks(BUILTIN_COMMANDS);

  it('derives counts and samples from the registry', () => {
    for (const row of rows) {
      const members = BUILTIN_COMMANDS.filter((cmd) => cmd.category === row.id);
      expect(row.count).toBe(members.length);
      expect(row.count).toBeGreaterThan(0);
      expect(row.sample).toEqual(members.slice(0, 3).map((cmd) => cmd.keys[0]));
      expect(row.sample.length).toBeLessThanOrEqual(3);
    }
  });
});
