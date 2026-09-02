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
  ALWAYS_ON_CATEGORIES,
  HIDDEN_CATEGORIES,
  OPTIONAL_CATEGORIES,
  STARTER_CATEGORIES,
  applyCategoryPick,
  categoryPicks,
  effectiveCategories,
  hasOnboarded,
  migrateNewBuiltins,
} from '../src/lib/onboarding';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { buildKeyMap, mergeCommands } from '../src/lib/resolve';
import { shortcutId } from '../src/lib/overrides';
import { CATEGORIES, DEFAULT_OVERRIDES } from '../src/lib/types';
import type { BuiltinCommand, Overrides } from '../src/lib/types';

/** The ids the registry ships in a category — the answer a pick has to match. */
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

describe('effectiveCategories', () => {
  it('adds the packs nobody gets to decline', () => {
    expect(effectiveCategories(['dev'])).toEqual(['dev', 'meta']);
  });

  it('answers in registry order whatever order the picker asked in', () => {
    expect(effectiveCategories(['purdue', 'ai', 'dev'])).toEqual(['ai', 'dev', 'purdue', 'meta']);
  });

  it('dedupes and normalizes what the picker hands it', () => {
    expect(effectiveCategories(['dev', ' DEV ', 'dev'])).toEqual(['dev', 'meta']);
  });

  it('drops an id that names no shipped pack', () => {
    // A pick names shipped packs. A user section holds no builtins, so one in
    // this list could only ever be a no-op that outlives the section.
    expect(effectiveCategories(['dev', 'sec-work', 'media'])).toEqual(['dev', 'meta']);
  });

  it('reads an empty pick as a real answer, not as no answer', () => {
    expect(effectiveCategories([])).toEqual([...ALWAYS_ON_CATEGORIES]);
    expect(effectiveCategories(null)).toEqual([...ALWAYS_ON_CATEGORIES]);
  });
});

describe('hasOnboarded', () => {
  it('is false only while the pick is null', () => {
    expect(hasOnboarded(DEFAULT_OVERRIDES)).toBe(false);
    expect(hasOnboarded({ ...DEFAULT_OVERRIDES, enabledCategories: [] })).toBe(true);
    expect(hasOnboarded({ ...DEFAULT_OVERRIDES, enabledCategories: ['dev'] })).toBe(true);
  });

  it('does not read seenBuiltins, which the update migration writes on its own', () => {
    const migrated = migrateNewBuiltins(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);
    expect(migrated.seenBuiltins.length).toBe(BUILTIN_COMMANDS.length);
    expect(hasOnboarded(migrated)).toBe(false);
  });
});

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

  it('picking nothing writes [] plus always-on meta and disables every other builtin', () => {
    const next = applyCategoryPick(BUILTIN_COMMANDS, [], DEFAULT_OVERRIDES);
    expect(next.enabledCategories).toEqual([...ALWAYS_ON_CATEGORIES]);
    const surviving = mergeCommands(BUILTIN_COMMANDS, next);
    expect(surviving.length).toBe(idsIn('meta').length);
    for (const cmd of surviving) expect(cmd.category).toBe('meta');
  });

  it('records the pick and marks every shipped id as seen', () => {
    const next = applyCategoryPick(BUILTIN_COMMANDS, ['dev'], DEFAULT_OVERRIDES);
    expect(new Set(next.seenBuiltins)).toEqual(new Set(BUILTIN_COMMANDS.map(shortcutId)));
  });

  it('re-pick re-enables a hand-disabled shortcut in a picked pack', () => {
    // Documented and accepted: the welcome page says "these are the packs I
    // want", and it has to mean something. The alternative — remembering a
    // hand-toggle through a re-pick — makes the picker a no-op for anyone who
    // has ever touched a switch.
    const handOff: Overrides = { ...DEFAULT_OVERRIDES, disabled: ['gh'] };
    const next = applyCategoryPick(BUILTIN_COMMANDS, ['dev'], handOff);
    expect(next.disabled).not.toContain('gh');
    expect(keysOf(next).has('gh')).toBe(true);
  });

  it('leaves a custom shortcut the user turned off alone', () => {
    const mine: Overrides = { ...DEFAULT_OVERRIDES, disabled: ['u:tix'] };
    expect(applyCategoryPick(BUILTIN_COMMANDS, ['dev'], mine).disabled).toContain('u:tix');
  });

  it('does not touch deleted: a deleted shortcut stays deleted through a re-pick', () => {
    const deleted: Overrides = { ...DEFAULT_OVERRIDES, deleted: ['gh'] };
    const next = applyCategoryPick(BUILTIN_COMMANDS, ['dev'], deleted);
    expect(next.deleted).toEqual(['gh']);
    expect(keysOf(next).has('gh')).toBe(false);
  });

  it('does not mutate the overrides it was handed', () => {
    const before = JSON.stringify(DEFAULT_OVERRIDES);
    applyCategoryPick(BUILTIN_COMMANDS, ['dev'], DEFAULT_OVERRIDES);
    expect(JSON.stringify(DEFAULT_OVERRIDES)).toBe(before);
  });

  it('is idempotent', () => {
    const once = applyCategoryPick(BUILTIN_COMMANDS, STARTER_CATEGORIES, DEFAULT_OVERRIDES);
    const twice = applyCategoryPick(BUILTIN_COMMANDS, STARTER_CATEGORIES, once);
    expect(twice).toEqual(once);
  });
});

describe('migrateNewBuiltins', () => {
  const seeded = applyCategoryPick(BUILTIN_COMMANDS, ['dev'], DEFAULT_OVERRIDES);

  it('returns the same reference when nothing is new', () => {
    // An identity check is what lets the update path skip the write, and with
    // it the `syncRules` round trip a write would schedule.
    expect(migrateNewBuiltins(BUILTIN_COMMANDS, seeded)).toBe(seeded);
  });

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

  it('a new builtin in a picked category arrives enabled', () => {
    const registry: BuiltinCommand[] = [
      ...BUILTIN_COMMANDS,
      builtin({ keys: ['zz'], category: 'dev' }),
    ];
    const migrated = migrateNewBuiltins(registry, seeded);
    expect(migrated.disabled).not.toContain('zz');
    expect(new Set(buildKeyMap(mergeCommands(registry, migrated)).keys()).has('zz')).toBe(true);
  });

  it('leaves a new always-on builtin enabled even though nobody picked meta', () => {
    const registry: BuiltinCommand[] = [
      ...BUILTIN_COMMANDS,
      builtin({ keys: ['zz'], category: 'meta' }),
    ];
    expect(migrateNewBuiltins(registry, seeded).disabled).not.toContain('zz');
  });

  it('is idempotent: a second run neither re-disables nor re-enables', () => {
    const registry: BuiltinCommand[] = [
      ...BUILTIN_COMMANDS,
      builtin({ keys: ['zz'], category: 'purdue' }),
    ];
    const once = migrateNewBuiltins(registry, seeded);
    expect(migrateNewBuiltins(registry, once)).toBe(once);
  });

  it('does not re-enable a builtin the user turned off by hand', () => {
    const handOff: Overrides = { ...seeded, disabled: [...seeded.disabled, 'gh'] };
    const registry: BuiltinCommand[] = [
      ...BUILTIN_COMMANDS,
      builtin({ keys: ['zz'], category: 'dev' }),
    ];
    expect(migrateNewBuiltins(registry, handOff).disabled).toContain('gh');
  });

  it('does not mutate the overrides it was handed', () => {
    const before = JSON.stringify(seeded);
    migrateNewBuiltins([...BUILTIN_COMMANDS, builtin({ keys: ['zz'] })], seeded);
    expect(JSON.stringify(seeded)).toBe(before);
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

  it('lists every member of a pack, in registry order, so the card can unfold', () => {
    for (const row of rows) {
      const members = BUILTIN_COMMANDS.filter((cmd) => cmd.category === row.id);
      expect(row.members.map((member) => member.id)).toEqual(members.map(shortcutId));
      expect(row.members.map((member) => member.keys)).toEqual(members.map((cmd) => cmd.keys));
      expect(row.members.map((member) => member.name)).toEqual(members.map((cmd) => cmd.name));
      expect(row.members).toHaveLength(row.count);
      // The sample is the head of the same list, not a second derivation.
      expect(row.sample).toEqual(row.members.slice(0, 3).map((member) => member.keys[0]));
    }
  });

  it('copies the keys rather than aliasing the registry', () => {
    const row = rows[0];
    row.members[0].keys.push('zz-probe');
    expect(BUILTIN_COMMANDS.find((cmd) => shortcutId(cmd) === row.members[0].id)?.keys).not.toContain(
      'zz-probe',
    );
  });

  it('hides the packs nobody chooses', () => {
    for (const hidden of HIDDEN_CATEGORIES) {
      expect(rows.map((row) => row.id)).not.toContain(hidden);
    }
  });

  it('offers every other shipped pack, in registry order', () => {
    expect(rows.map((row) => row.id)).toEqual(
      CATEGORIES.filter((category) => !(HIDDEN_CATEGORIES as string[]).includes(category)),
    );
  });

  it('marks the starter packs and the optional ones', () => {
    const starters = rows.filter((row) => row.starter).map((row) => row.id);
    expect(new Set(starters)).toEqual(new Set(STARTER_CATEGORIES));
    expect(rows.filter((row) => row.optional).map((row) => row.id)).toEqual([
      ...OPTIONAL_CATEGORIES,
    ]);
  });

  it('carries the labels the browse list uses', () => {
    for (const row of rows) expect(row.label.trim().length).toBeGreaterThan(0);
  });

  it('drops a pack with nothing in it', () => {
    const thin = BUILTIN_COMMANDS.filter((cmd) => cmd.category !== 'social');
    expect(categoryPicks(thin).map((row) => row.id)).not.toContain('social');
  });
});
