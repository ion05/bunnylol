import { describe, expect, it } from 'vitest';
import {
  activeKeywords,
  buildKeyMap,
  isBouncedUrl,
  mergeCommands,
  resolve,
  suggest,
} from '../src/lib/resolve';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  DEFAULT_STOP_LIST,
  FORCE_SEARCH_PREFIXES,
} from '../src/lib/types';
import type { Command, Overrides, Settings } from '../src/lib/types';

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function overrides(patch: Partial<Overrides> = {}): Overrides {
  return { ...DEFAULT_OVERRIDES, ...patch };
}

// The keys are a non-empty tuple, so the lead alias this fills `name` and `url`
// from is present by the type rather than by convention.
function cmd(patch: Partial<Command> & { keys: [string, ...string[]] }): Command {
  return {
    name: patch.keys[0],
    description: '',
    url: `https://example.com/${patch.keys[0]}`,
    category: 'custom',
    builtin: false,
    ...patch,
  };
}

const GOOGLE = 'https://www.google.com/search?q=';

describe('resolve', () => {
  const commands = BUILTIN_COMMANDS;

  it('routes a bare keyword to the command home', () => {
    const result = resolve('gh', commands, settings());
    expect(result.url).toBe('https://github.com/');
    expect(result.command?.keys[0]).toBe('gh');
    expect(result.args).toBe('');
    expect(result.fallback).toBe(false);
  });

  it('routes a keyword with arguments through its handler', () => {
    const result = resolve('gh facebook/react', commands, settings());
    expect(result.url).toBe('https://github.com/facebook/react');
    expect(result.args).toBe('facebook/react');
    expect(result.fallback).toBe(false);
  });

  it('falls through to the default engine for an unknown keyword', () => {
    const result = resolve('zzzznotacommand foo', commands, settings());
    expect(result.url).toBe(`${GOOGLE}zzzznotacommand%20foo&blpass=1`);
    expect(result.command).toBeNull();
    expect(result.args).toBe('zzzznotacommand foo');
    expect(result.fallback).toBe(true);
  });

  it('matches the keyword case-insensitively but preserves argument case', () => {
    const upper = resolve('GH Facebook/React', commands, settings());
    expect(upper.command?.keys[0]).toBe('gh');
    expect(upper.url).toBe('https://github.com/Facebook/React');
    expect(resolve('GiThUb', commands, settings()).command?.keys[0]).toBe('gh');
  });

  it.each(FORCE_SEARCH_PREFIXES)('forces a plain search with the %j escape', (prefix) => {
    const escaped = resolve(`${prefix}gh facebook/react`, commands, settings());
    expect(escaped.url).toBe(`${GOOGLE}gh%20facebook%2Freact&blpass=1`);
    expect(escaped.command).toBeNull();
    expect(escaped.args).toBe('gh facebook/react');
    expect(escaped.fallback).toBe(true);
    // The prefix is the user's instruction, not part of what they searched for.
    expect(escaped.url).not.toContain(encodeURIComponent(prefix));
  });

  it('only escapes at the very start of the query', () => {
    // `2 = 2` and `c:\\temp` are ordinary searches, not escapes.
    expect(resolve('2 = 2', commands, settings()).url).toBe(`${GOOGLE}2%20%3D%202&blpass=1`);
    expect(resolve('gh a=b', commands, settings()).command?.keys).toContain('gh');
  });

  // Invariant 12: resolve() never throws. A handler that blows up degrades to
  // the command's bare destination, so every surface can call this blind.
  it('never throws and always yields a url, however hostile the query', () => {
    const HOSTILE = [
      '',
      ' ',
      '\t\n',
      '\\',
      '\\\\gh',
      '=',
      '==gh',
      '%',
      '%zz',
      'gh %',
      '{q}',
      '%s',
      '__proto__',
      'constructor prototype',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'r/',
      '@',
      'gh me',
      '\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8',
      '\uD800',
      'gh \uD800',
      'a'.repeat(5000),
      'gh '.repeat(500),
      'set\u0000null',
    ];
    for (const input of HOSTILE) {
      const result = resolve(input, commands, settings());
      expect(typeof result.url, input).toBe('string');
      expect(result.url.length, input).toBeGreaterThan(0);
      expect(typeof result.args, input).toBe('string');
      expect(typeof result.fallback, input).toBe('boolean');
    }
  });
});

describe('mergeCommands', () => {
  it('removes a disabled builtin and every one of its aliases', () => {
    const merged = mergeCommands(BUILTIN_COMMANDS, overrides({ disabled: ['gh'] }));
    const keys = buildKeyMap(merged);
    expect(keys.has('gh')).toBe(false);
    expect(keys.has('github')).toBe(false);
    expect(keys.has('npm')).toBe(true);
  });

  it('lets a custom command shadow a builtin alias', () => {
    const mine = cmd({ keys: ['gh'], name: 'My hub', url: 'https://internal.test/' });
    const merged = mergeCommands(BUILTIN_COMMANDS, overrides({ custom: [mine] }));
    expect(buildKeyMap(merged).get('gh')?.name).toBe('My hub');
    // The shadowed builtin keeps its other aliases.
    expect(buildKeyMap(merged).get('github')?.name).toBe('GitHub');
    expect(resolve('gh anything', merged, settings()).url).toBe('https://internal.test/');
  });

  it('hides a deleted builtin and every one of its aliases', () => {
    const keys = buildKeyMap(mergeCommands(BUILTIN_COMMANDS, overrides({ deleted: ['gh'] })));
    expect(keys.has('gh')).toBe(false);
    expect(keys.has('github')).toBe(false);
    expect(keys.has('npm')).toBe(true);
  });

  // SECURITY: an edit is user data from an import file, and these four fields
  // choose which handler runs (invariant 16).
  it('lets an edit change none of handler, provider, builtin or id', () => {
    const smuggled = {
      handler: 'ai',
      provider: 'chatgpt',
      builtin: false,
      id: 'evil',
      name: 'Mine',
    } as unknown as NonNullable<Overrides['edits']>[string];
    const merged = mergeCommands(BUILTIN_COMMANDS, overrides({ edits: { gh: smuggled } }));
    const gh = buildKeyMap(merged).get('gh');
    expect(gh?.handler).toBe('github');
    expect(gh?.provider).toBeUndefined();
    expect(gh?.builtin).toBe(true);
    expect(gh?.id).toBe('gh');
    expect(gh?.name).toBe('Mine');
  });

  it('still resolves an edited builtin whose url the edit blanked', () => {
    // Invariant 12: `rawDestination` hands `cmd.url` to the navigation, so an
    // edit that empties it must inherit rather than produce a bare ''.
    const merged = mergeCommands(
      BUILTIN_COMMANDS,
      overrides({ edits: { gh: { url: '   ', name: 'Hub' } } }),
    );
    const shipped = BUILTIN_COMMANDS.find((command) => command.keys[0] === 'gh');
    expect(resolve('gh', merged, settings()).url).toBe(shipped?.url);
    expect(buildKeyMap(merged).get('gh')?.name).toBe('Hub');
  });
});

describe('suggest', () => {
  // One command per scoring tier, deliberately out of both score order and key
  // order so the assertion proves the comparator rather than the input order.
  const ranked: Command[] = [
    cmd({ keys: ['gopher'], name: 'Zebra', description: 'nothing here' }), // subsequence g..h
    cmd({ keys: ['ghc'], name: 'Code search', description: 'search code' }), // alias prefix
    cmd({ keys: ['zz2'], name: 'Tools', description: 'great ghost hunting' }), // word contains
    cmd({ keys: ['gh'], name: 'GitHub', description: 'repos' }), // exact alias
    cmd({ keys: ['ghb'], name: 'Other', description: 'other' }), // alias prefix, sorts first
    cmd({ keys: ['zz1'], name: 'ghost writer', description: 'writing' }), // name prefix
    cmd({ keys: ['nope'], name: 'Nope', description: 'unrelated' }),
  ];

  it('ranks exact alias > alias prefix > name prefix > word contains > subsequence', () => {
    expect(suggest('gh', ranked, 10).map((c) => c.keys[0])).toEqual([
      'gh',
      'ghb',
      'ghc',
      'zz1',
      'zz2',
      'gopher',
    ]);
  });
});

describe('activeKeywords', () => {
  it('exempts nothing by default: every alias is intercepted', () => {
    expect(DEFAULT_STOP_LIST).toEqual([]);
    const intercepted = activeKeywords(BUILTIN_COMMANDS, DEFAULT_STOP_LIST);
    expect(intercepted).toEqual(activeKeywords(BUILTIN_COMMANDS));
    for (const alias of ['new', 'r', 'help', 'maps', 'gh']) {
      expect(intercepted, `${alias} is not intercepted`).toContain(alias);
    }
  });

  it('suppresses a user exemption from interception only', () => {
    const intercepted = activeKeywords(BUILTIN_COMMANDS, ['new', 'r']);
    expect(intercepted).not.toContain('new');
    expect(intercepted).not.toContain('r');
    expect(intercepted).toContain('gh');
    // ...but the resolver still routes them, which is the whole point.
    for (const alias of ['new', 'r', 'help']) {
      const result = resolve(alias, mergeCommands(BUILTIN_COMMANDS, overrides()), settings());
      expect(result.fallback).toBe(false);
    }
  });
});

describe('isBouncedUrl', () => {
  it('refuses a non-http scheme so a bad shortcut cannot smuggle one through', () => {
    expect(isBouncedUrl('javascript:alert(1)?blpass=1')).toBe(false);
    expect(isBouncedUrl('data:text/html,x?blpass=1')).toBe(false);
  });
});
