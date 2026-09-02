import { describe, expect, it } from 'vitest';
import {
  MAX_ID_LENGTH,
  USER_ID_PREFIX,
  isUserId,
  mintUserId,
  normalizeId,
  shortcutId,
} from '../src/lib/overrides';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { MAX_KEYWORD_LENGTH } from '../src/lib/validate';
import type { Command } from '../src/lib/types';

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

describe('shortcutId', () => {
  it('identifies a shipped command by its canonical key', () => {
    for (const builtin of BUILTIN_COMMANDS) {
      expect(shortcutId(builtin)).toBe(builtin.keys[0]);
    }
  });

  it('prefers an explicit id over the keys', () => {
    expect(shortcutId(cmd({ id: 'u:tix', keys: ['tickets', 'tix'] }))).toBe('u:tix');
  });

  it('trims and lowercases', () => {
    expect(shortcutId(cmd({ id: '  U:TIX ' }))).toBe('u:tix');
    expect(shortcutId(cmd({ id: '', keys: ['  TiX  '] }))).toBe('tix');
  });

  it('ignores an id no minting could have produced', () => {
    // A whitespace id is unusable, so the command falls back to its keyword
    // rather than being filed under a name no UI can produce again.
    expect(shortcutId(cmd({ id: 'bad id', keys: ['x'] }))).toBe('x');
    expect(shortcutId(cmd({ id: 'x'.repeat(MAX_ID_LENGTH + 1), keys: ['x'] }))).toBe('x');
    expect(shortcutId(cmd({ id: 42 as unknown as string, keys: ['x'] }))).toBe('x');
  });

  it('never falls back into the user namespace', () => {
    // A colon is a legal alias character, so a keyword can look like a minted
    // id. Adopting it would put a command storage never minted for on an id
    // storage may hand to something else.
    expect(shortcutId(cmd({ keys: ['u:tix'] }))).toBe('');
    expect(shortcutId(cmd({ id: 'u:tix', keys: ['u:tix'] }))).toBe('u:tix');
  });

  it('returns an empty string when there is nothing to go on', () => {
    expect(shortcutId(cmd({ keys: [] }))).toBe('');
    expect(shortcutId(undefined as unknown as Command)).toBe('');
  });
});

describe('normalizeId', () => {
  const cases: Array<[unknown, string]> = [
    ['gh', 'gh'],
    ['  U:TIX  ', 'u:tix'],
    ['', ''],
    ['   ', ''],
    ['has space', ''],
    ['tab\there', ''],
    ['x'.repeat(MAX_ID_LENGTH), 'x'.repeat(MAX_ID_LENGTH)],
    ['x'.repeat(MAX_ID_LENGTH + 1), ''],
    [null, ''],
    [42, ''],
    [{ id: 'gh' }, ''],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeId(input)).toBe(expected);
    });
  }
});

describe('isUserId', () => {
  it('separates the user namespace from the shipped one', () => {
    expect(isUserId('u:tix')).toBe(true);
    expect(isUserId('gh')).toBe(false);
    expect(isUserId('')).toBe(false);
    // No shipped id may land in the user namespace. `validateAlias` does NOT
    // enforce that — a colon is a legal alias character — so this sweep is the
    // guard on the registry itself, alongside `shortcutId`'s refusal to adopt a
    // `u:` keyword as an id.
    expect(BUILTIN_COMMANDS.some((builtin) => isUserId(shortcutId(builtin)))).toBe(false);
  });
});

describe('the registry always has an identity', () => {
  it('gives every shipped command a non-empty id', () => {
    // The adjacent and more damaging failure to the `u:` one above: a first
    // keyword past `MAX_ID_LENGTH` or containing whitespace leaves the command
    // with the id `''`, which the options page then writes overrides under and
    // storage silently drops — rebinding and disabling appear to work and
    // persist nothing, and two such commands share every override entry.
    expect(BUILTIN_COMMANDS.filter((builtin) => shortcutId(builtin) === '')).toEqual([]);
  });

  it('caps an id no lower than the alias it falls back to', () => {
    expect(MAX_ID_LENGTH).toBeGreaterThanOrEqual(MAX_KEYWORD_LENGTH);
  });
});

describe('mintUserId', () => {
  it('slugs the seed under the user prefix', () => {
    expect(mintUserId('tix', new Set())).toBe('u:tix');
    expect(mintUserId('My Shortcut!', new Set())).toBe('u:my-shortcut');
    expect(mintUserId('  Über Café  ', new Set())).toBe('u:ber-caf');
    // `_` is legal in a keyword but not in a minted id: the slug alphabet is
    // the one `validateSectionId` accepts, so every generated id reads alike.
    expect(mintUserId('snake_case-9', new Set())).toBe('u:snake-case-9');
  });

  it('falls back to a readable slug when the seed has nothing usable', () => {
    expect(mintUserId('', new Set())).toBe('u:shortcut');
    expect(mintUserId('!!!', new Set())).toBe('u:shortcut');
    expect(mintUserId(undefined as unknown as string, new Set())).toBe('u:shortcut');
  });

  it('suffixes until the id is free', () => {
    const taken = new Set(['u:tix']);
    expect(mintUserId('tix', taken)).toBe('u:tix-2');
    taken.add('u:tix-2');
    expect(mintUserId('tix', taken)).toBe('u:tix-3');
  });

  it('is deterministic', () => {
    expect(mintUserId('tix', new Set(['u:tix']))).toBe(mintUserId('tix', new Set(['u:tix'])));
  });

  it('stays inside the length cap, suffix included', () => {
    const taken = new Set<string>();
    for (let n = 0; n < 12; n += 1) {
      const id = mintUserId('x'.repeat(60), taken);
      expect(id.length).toBeLessThanOrEqual(MAX_ID_LENGTH);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });

  it('never trails a dash into the suffix', () => {
    const long = `${'a'.repeat(MAX_ID_LENGTH - USER_ID_PREFIX.length - 1)}-tail`;
    expect(mintUserId(long, new Set())).not.toMatch(/-$/);
    expect(mintUserId(long, new Set([mintUserId(long, new Set())]))).not.toContain('--');
  });

  it('cannot collide with a shipped id', () => {
    const shipped = new Set(BUILTIN_COMMANDS.map(shortcutId));
    for (const builtin of BUILTIN_COMMANDS) {
      expect(shipped.has(mintUserId(builtin.keys[0], new Set()))).toBe(false);
    }
  });

  it('never repeats an id already handed out', () => {
    const taken = new Set<string>();
    for (let n = 0; n < 50; n += 1) {
      const id = mintUserId('tix', taken);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    expect(taken.size).toBe(50);
  });
});
