import { describe, expect, it } from 'vitest';
import {
  activeKeywords,
  buildKeyMap,
  expandTemplate,
  hasPassthrough,
  isBouncedUrl,
  mergeCommands,
  resolve,
  stripPassthrough,
  suggest,
  withPassthrough,
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
  return { ...DEFAULT_OVERRIDES, disabled: [], keyOverrides: {}, custom: [], ...patch };
}

function cmd(patch: Partial<Command> & { keys: string[] }): Command {
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

describe('expandTemplate', () => {
  it('substitutes {q} and %s with encoded args', () => {
    expect(expandTemplate('https://x.test/s?q={q}', 'a b')).toBe('https://x.test/s?q=a%20b');
    expect(expandTemplate('https://x.test/s?q=%s', 'a b')).toBe('https://x.test/s?q=a%20b');
  });

  it('replaces every occurrence of the placeholder', () => {
    expect(expandTemplate('https://x.test/{q}?q={q}', 'ab')).toBe('https://x.test/ab?q=ab');
  });

  it('does not treat encoded args as a replacement pattern', () => {
    // `$&` survives encoding as `%24&`; a naive String.replace would re-inject
    // the whole match here.
    expect(expandTemplate('https://x.test/s?q={q}', '$&')).toBe('https://x.test/s?q=%24%26');
  });

  it('appends q= when the template has no placeholder', () => {
    expect(expandTemplate('https://x.test/s', 'a b')).toBe('https://x.test/s?q=a%20b');
    expect(expandTemplate('https://x.test/s?hl=en', 'a b')).toBe('https://x.test/s?hl=en&q=a%20b');
  });

  it('leaves a placeholderless template alone when there are no args', () => {
    expect(expandTemplate('https://x.test/s', '')).toBe('https://x.test/s');
  });
});

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

  it('honours a custom default engine on fallback', () => {
    const result = resolve('quantum foam', commands, settings({ defaultEngine: 'https://kagi.com/search?q={q}' }));
    expect(result.url).toBe('https://kagi.com/search?q=quantum%20foam&blpass=1');
  });

  it('matches the keyword case-insensitively but preserves argument case', () => {
    const upper = resolve('GH Facebook/React', commands, settings());
    expect(upper.command?.keys[0]).toBe('gh');
    expect(upper.url).toBe('https://github.com/Facebook/React');
    expect(resolve('GiThUb', commands, settings()).command?.keys[0]).toBe('gh');
  });

  it('collapses whitespace around the keyword but keeps internal spacing', () => {
    const result = resolve('  wiki   foo   bar  ', commands, settings());
    expect(result.command?.keys[0]).toBe('wiki');
    expect(result.args).toBe('foo   bar');
    expect(result.url).toBe('https://en.wikipedia.org/w/index.php?search=foo%20%20%20bar');
  });

  it('sends a whitespace-only query to the engine home, not a search for ""', () => {
    for (const blank of ['', '   ', '\t', '\n  \t ']) {
      const result = resolve(blank, commands, settings());
      expect(result.url).toBe('https://www.google.com/');
      expect(result.command).toBeNull();
      expect(result.args).toBe('');
      expect(result.fallback).toBe(true);
    }
  });

  it('encodes arguments containing url metacharacters and unicode', () => {
    const result = resolve('wiki a&b#c+d/e%f 日本語', commands, settings());
    expect(result.url).toBe(
      'https://en.wikipedia.org/w/index.php?search=a%26b%23c%2Bd%2Fe%25f%20%E6%97%A5%E6%9C%AC%E8%AA%9E',
    );
    // The encoded value must not leak a second parameter into the url.
    expect(new URL(result.url).searchParams.get('search')).toBe('a&b#c+d/e%f 日本語');
  });

  it('drops arguments for a command that has no searchUrl and no handler', () => {
    const plain = cmd({ keys: ['plain'], url: 'https://plain.test/' });
    const result = resolve('plain some args', [plain], settings());
    expect(result.url).toBe('https://plain.test/');
    expect(result.args).toBe('some args');
    expect(result.fallback).toBe(false);
  });

  it('resolves every alias of a command to the same destination', () => {
    const canonical = resolve('gmail from:advisor', commands, settings());
    for (const alias of ['gm', 'mail']) {
      const viaAlias = resolve(`${alias} from:advisor`, commands, settings());
      expect(viaAlias.url).toBe(canonical.url);
      expect(viaAlias.command).toBe(canonical.command);
    }
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

  it.each(FORCE_SEARCH_PREFIXES)('accepts a space after %j, and the bare prefix', (prefix) => {
    expect(resolve(`${prefix} gh react`, commands, settings()).url).toBe(`${GOOGLE}gh%20react&blpass=1`);
    expect(resolve(prefix, commands, settings()).url).toBe('https://www.google.com/');
  });

  it('ships both escapes and no prefix of another', () => {
    expect(FORCE_SEARCH_PREFIXES).toEqual(['\\', '=']);
    for (const a of FORCE_SEARCH_PREFIXES) {
      for (const b of FORCE_SEARCH_PREFIXES) {
        if (a !== b) expect(a.startsWith(b)).toBe(false);
      }
    }
  });

  it('only escapes at the very start of the query', () => {
    // `2 = 2` and `c:\\temp` are ordinary searches, not escapes.
    expect(resolve('2 = 2', commands, settings()).url).toBe(`${GOOGLE}2%20%3D%202&blpass=1`);
    expect(resolve('gh a=b', commands, settings()).command?.keys).toContain('gh');
  });

  const HOSTILE: string[] = [
    '',
    ' ',
    '\t\n',
    '\\',
    '\\\\',
    '\\\\gh',
    '=',
    '==',
    '==gh',
    '?',
    '??',
    '? ',
    '%',
    '%%%',
    '%zz',
    'gh %',
    'wiki 100%',
    '#',
    '&&&',
    '{q}',
    '%s',
    'gh {q}',
    '__proto__',
    'constructor prototype',
    'toString',
    'null',
    'undefined',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'wiki 99999999999999999999',
    'r/',
    '@',
    'gh me',
    '日本語 テスト',
    '🐰 bunny lol',
    '\uD800',
    'wiki \uD800\uD800',
    'gh \uD800',
    '? \uDFFF',
    'a'.repeat(5000),
    'gh '.repeat(500),
    'set\u0000null',
    '‮gnp.exe',
  ];

  it.each(HOSTILE)('never throws and always yields a url for %j', (input) => {
    let result;
    expect(() => {
      result = resolve(input, commands, settings());
    }).not.toThrow();
    expect(typeof result!.url).toBe('string');
    expect(result!.url.length).toBeGreaterThan(0);
    expect(typeof result!.args).toBe('string');
    expect(typeof result!.fallback).toBe('boolean');
  });

  it('survives a malformed settings object', () => {
    const broken = { ...DEFAULT_SETTINGS, defaultEngine: '' } as Settings;
    expect(resolve('unknown thing', commands, broken).url).toBe(`${GOOGLE}unknown%20thing&blpass=1`);
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

  it('replaces a builtin key list with its override', () => {
    const merged = mergeCommands(BUILTIN_COMMANDS, overrides({ keyOverrides: { gh: ['hub', 'gh2'] } }));
    const keys = buildKeyMap(merged);
    expect(keys.get('hub')?.name).toBe('GitHub');
    expect(keys.get('gh2')?.name).toBe('GitHub');
    expect(keys.has('gh')).toBe(false);
    expect(keys.has('github')).toBe(false);
  });

  it('treats an empty override list as no override', () => {
    const merged = mergeCommands(BUILTIN_COMMANDS, overrides({ keyOverrides: { gh: [] } }));
    expect(buildKeyMap(merged).get('gh')?.name).toBe('GitHub');
  });

  it('lets a custom command shadow a builtin alias', () => {
    const mine = cmd({ keys: ['gh'], name: 'My hub', url: 'https://internal.test/' });
    const merged = mergeCommands(BUILTIN_COMMANDS, overrides({ custom: [mine] }));
    expect(buildKeyMap(merged).get('gh')?.name).toBe('My hub');
    // The shadowed builtin keeps its other aliases.
    expect(buildKeyMap(merged).get('github')?.name).toBe('GitHub');
    expect(resolve('gh anything', merged, settings()).url).toBe('https://internal.test/');
  });

  it('mutates neither the builtin registry nor the overrides', () => {
    const builtinsBefore = structuredClone(BUILTIN_COMMANDS);
    const input = overrides({
      disabled: ['npm'],
      keyOverrides: { gh: ['hub'] },
      custom: [cmd({ keys: ['tix'], url: 'https://tix.test/' })],
    });
    const inputBefore = structuredClone(input);

    const merged = mergeCommands(BUILTIN_COMMANDS, input);
    merged[0].keys.push('mutated');
    merged[0].name = 'mutated';

    expect(BUILTIN_COMMANDS).toEqual(builtinsBefore);
    expect(input).toEqual(inputBefore);
  });

  it('tolerates a partial overrides object', () => {
    const merged = mergeCommands(BUILTIN_COMMANDS, {} as Overrides);
    expect(merged.length).toBe(BUILTIN_COMMANDS.length);
  });

  it('stamps a stable id on every command it emits', () => {
    const mine = cmd({ keys: ['tix'], id: 'u:tix', url: 'https://tix.test/' });
    const merged = mergeCommands(
      BUILTIN_COMMANDS,
      overrides({ custom: [mine], keyOverrides: { gh: ['hub'] } }),
    );
    expect(merged.every((command) => (command.id ?? '') !== '')).toBe(true);
    expect(merged.find((command) => command.name === 'GitHub')?.id).toBe('gh');
    expect(merged[0].id).toBe('u:tix');
  });

  it('keeps a rebound builtin under its shipped id', () => {
    // The id is what the override maps are keyed by, so it must not follow the
    // keys the user just rebound.
    const merged = mergeCommands(BUILTIN_COMMANDS, overrides({ keyOverrides: { gh: ['hub'] } }));
    const rebound = buildKeyMap(merged).get('hub');
    expect(rebound?.id).toBe('gh');
    expect(rebound?.keys).toEqual(['hub']);
  });

  it('falls back to the canonical key for a custom command with no id', () => {
    const merged = mergeCommands(
      BUILTIN_COMMANDS,
      overrides({ custom: [cmd({ keys: ['tix'], url: 'https://tix.test/' })] }),
    );
    expect(merged[0].id).toBe('tix');
  });

  it('never writes an id back into the registry', () => {
    mergeCommands(BUILTIN_COMMANDS, overrides({ custom: [cmd({ keys: ['tix'] })] }));
    expect(BUILTIN_COMMANDS[0].id).toBeUndefined();
    expect(BUILTIN_COMMANDS.every((command) => command.id === undefined)).toBe(true);
  });
});

describe('buildKeyMap', () => {
  it('gives an alias to the first command that claims it', () => {
    const first = cmd({ keys: ['x'], name: 'First' });
    const second = cmd({ keys: ['x', 'y'], name: 'Second' });
    const map = buildKeyMap([first, second]);
    expect(map.get('x')?.name).toBe('First');
    expect(map.get('y')?.name).toBe('Second');
  });

  it('lowercases and trims aliases and skips empty ones', () => {
    const map = buildKeyMap([cmd({ keys: ['  MiXeD  ', '', '   '], name: 'One' })]);
    expect(map.get('mixed')?.name).toBe('One');
    expect(map.size).toBe(1);
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

  it('is deterministic across calls', () => {
    const once = suggest('gh', ranked, 10).map((c) => c.keys[0]);
    const twice = suggest('gh', ranked, 10).map((c) => c.keys[0]);
    expect(twice).toEqual(once);
  });

  it('respects the limit and defaults to eight', () => {
    expect(suggest('gh', ranked, 2).map((c) => c.keys[0])).toEqual(['gh', 'ghb']);
    expect(suggest('gh', ranked, 0)).toEqual([]);
    expect(suggest('gh', ranked, -1)).toEqual([]);
    expect(suggest('g', BUILTIN_COMMANDS).length).toBe(8);
  });

  it('returns registry order for an empty query', () => {
    expect(suggest('   ', ranked, 3)).toEqual(ranked.slice(0, 3));
  });

  it('falls back to the keyword once arguments are being typed', () => {
    expect(suggest('gh facebo', ranked, 3).map((c) => c.keys[0])).toEqual(['gh', 'ghb', 'ghc']);
  });

  it('returns nothing when nothing matches', () => {
    expect(suggest('qqqqqqqq', ranked, 5)).toEqual([]);
  });
});

describe('activeKeywords', () => {
  it('dedupes, lowercases and sorts longest-first', () => {
    const keywords = activeKeywords([
      cmd({ keys: ['gh', 'github'] }),
      cmd({ keys: ['GH', 'g'] }),
      cmd({ keys: ['gitlab'] }),
    ]);
    expect(keywords).toEqual(['github', 'gitlab', 'gh', 'g']);
  });

  it('drops keys the DNR alternation cannot safely carry', () => {
    const keywords = activeKeywords([
      cmd({ keys: ['?', 'c++', 'two words', '-lead', 'ok_1', 'a'.repeat(33), ''] }),
    ]);
    expect(keywords).toEqual(['ok_1']);
  });

  it('produces only keys that survive a real registry unchanged', () => {
    const keywords = activeKeywords(BUILTIN_COMMANDS);
    expect(keywords).toContain('gh');
    expect(keywords).toContain('github');
    expect(keywords).not.toContain('?');
    expect(new Set(keywords).size).toBe(keywords.length);
    for (let i = 1; i < keywords.length; i += 1) {
      expect(keywords[i - 1].length).toBeGreaterThanOrEqual(keywords[i].length);
    }
  });

  it('suppresses stop-listed aliases, case-insensitively', () => {
    const commands = [cmd({ keys: ['new'] }), cmd({ keys: ['R', 'reddit'] }), cmd({ keys: ['gh'] })];
    expect(activeKeywords(commands, ['NEW', ' r ', '', 'notanalias'])).toEqual(['reddit', 'gh']);
  });

  it('leaves the keyword list alone without a stop list', () => {
    const commands = [cmd({ keys: ['new'] }), cmd({ keys: ['gh'] })];
    expect(activeKeywords(commands)).toEqual(activeKeywords(commands, []));
  });

  it('exempts nothing by default — every alias is intercepted', () => {
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

describe('passthrough marker', () => {
  it('marks a generated fallback search so our own rules skip it', () => {
    const result = resolve('\\gh react', mergeCommands(BUILTIN_COMMANDS, overrides()), settings());
    expect(hasPassthrough(result.url)).toBe(true);
  });

  it('does not mark a command destination or an engine home page', () => {
    const commands = mergeCommands(BUILTIN_COMMANDS, overrides());
    expect(hasPassthrough(resolve('gh facebook/react', commands, settings()).url)).toBe(false);
    expect(hasPassthrough(resolve('', commands, settings()).url)).toBe(false);
  });

  it('is idempotent and keeps the fragment last', () => {
    expect(withPassthrough('https://x.test/s?q=a')).toBe('https://x.test/s?q=a&blpass=1');
    expect(withPassthrough('https://x.test/s')).toBe('https://x.test/s?blpass=1');
    expect(withPassthrough('https://x.test/s?q=a#top')).toBe('https://x.test/s?q=a&blpass=1#top');
    expect(withPassthrough(withPassthrough('https://x.test/s?q=a'))).toBe('https://x.test/s?q=a&blpass=1');
  });

  it('strips the marker from any position without mangling the url', () => {
    expect(stripPassthrough('https://x.test/s?q=a&blpass=1')).toBe('https://x.test/s?q=a');
    expect(stripPassthrough('https://x.test/s?blpass=1&q=a')).toBe('https://x.test/s?q=a');
    expect(stripPassthrough('https://x.test/s?q=a&blpass=1&r=b')).toBe('https://x.test/s?q=a&r=b');
    expect(stripPassthrough('https://x.test/s?blpass=1')).toBe('https://x.test/s');
    expect(stripPassthrough('gh react')).toBe('gh react');
    // A query that legitimately mentions the parameter name is left alone.
    expect(stripPassthrough('https://x.test/s?q=blpass%3D1')).toBe('https://x.test/s?q=blpass%3D1');
  });
});

describe('handler keyword', () => {
  const commands = mergeCommands(BUILTIN_COMMANDS, overrides());

  it('hands a handler the alias the user typed, not the canonical one', () => {
    // Both aliases belong to the same command; a degrade to a plain search has
    // to reproduce the query the alias actually intercepted.
    expect(resolve('lh surge meaning', commands, settings()).url).toBe(
      `${GOOGLE}lh%20surge%20meaning&blpass=1`,
    );
    expect(resolve('localhost refused to connect fix', commands, settings()).url).toBe(
      `${GOOGLE}localhost%20refused%20to%20connect%20fix&blpass=1`,
    );
  });

  it('marks a handler-generated search so our own rules skip it', () => {
    expect(hasPassthrough(resolve('gs pay scale 2026', commands, settings()).url)).toBe(true);
  });

  it('leaves a shape-matched destination alone', () => {
    expect(resolve('zoom 1234567890', commands, settings()).url).toBe('https://zoom.us/j/1234567890');
    expect(resolve('wa +1 (555) 123-4567', commands, settings()).url).toBe('https://wa.me/15551234567');
  });

  it('follows a rebound alias into the plain-search degrade', () => {
    const rebound = mergeCommands(BUILTIN_COMMANDS, overrides({ keyOverrides: { lh: ['local'] } }));
    expect(resolve('local surge meaning', rebound, settings()).url).toBe(
      `${GOOGLE}local%20surge%20meaning&blpass=1`,
    );
  });
});

describe('isBouncedUrl', () => {
  it('claims a whole url carrying the marker', () => {
    expect(isBouncedUrl('https://www.google.com/search?q=gh%20foo&blpass=1')).toBe(true);
    expect(isBouncedUrl('http://example.com/?blpass=1')).toBe(true);
  });

  it('leaves query text alone even when it contains the marker verbatim', () => {
    // The bug this guards: go.ts used to run stripPassthrough over every
    // incoming query, so typing `gh foo&blpass=1` searched for `gh foo`.
    expect(isBouncedUrl('gh foo&blpass=1')).toBe(false);
    expect(isBouncedUrl('q=x&blpass=1')).toBe(false);
    expect(isBouncedUrl('yt foo&blpass=zzz&bar')).toBe(false);
  });

  it('ignores anything without the marker, url or not', () => {
    expect(isBouncedUrl('https://www.google.com/search?q=gh%20foo')).toBe(false);
    expect(isBouncedUrl('gh foo')).toBe(false);
    expect(isBouncedUrl('')).toBe(false);
  });

  it('refuses a non-http scheme so a bad shortcut cannot smuggle one through', () => {
    expect(isBouncedUrl('javascript:alert(1)?blpass=1')).toBe(false);
    expect(isBouncedUrl('data:text/html,x?blpass=1')).toBe(false);
  });

  it('preserves the user words a bounced-url strip would have eaten', () => {
    const typed = 'gh foo&blpass=1';
    expect(isBouncedUrl(typed) ? stripPassthrough(typed) : typed).toBe(typed);
  });
});
