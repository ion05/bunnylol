import { describe, expect, it } from 'vitest';
import { at } from './helpers/at';
import {
  MAX_ID_LENGTH,
  MAX_SECTIONS,
  USER_ID_PREFIX,
  addSection,
  applyEdit,
  deleteSection,
  diffEdit,
  fitSectionId,
  foldLegacyKeyOverrides,
  isShippedSection,
  isUserId,
  knownCategoryIds,
  mintUserId,
  newSectionId,
  normalizeId,
  renameSection,
  sectionLabel,
  sectionLabelTaken,
  sectionMembers,
  sectionOptions,
  sectionOrder,
  shortcutId,
} from '../src/lib/overrides';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { MAX_KEYWORD_LENGTH, MAX_SECTION_ID_LENGTH, validateSectionId } from '../src/lib/validate';
import { CATEGORIES, CATEGORY_LABELS, DEFAULT_OVERRIDES } from '../src/lib/types';
import type { Command, Overrides, Section, ShortcutEdit } from '../src/lib/types';

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
    // enforce that, a colon is a legal alias character, so this sweep is the
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
    // storage silently drops: rebinding and disabling appear to work and
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
      expect(shipped.has(mintUserId(at(builtin.keys, 0), new Set()))).toBe(false);
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

const SHIPPED: Command = {
  keys: ['gh', 'github'],
  name: 'GitHub',
  description: 'Repositories',
  url: 'https://github.com/',
  searchUrl: 'https://github.com/search?q={q}',
  handler: 'github',
  category: 'dev',
  builtin: true,
  example: 'gh facebook/react',
  id: 'gh',
};

describe('applyEdit', () => {
  it('returns the command untouched when there is no edit', () => {
    expect(applyEdit(SHIPPED, undefined)).toBe(SHIPPED);
  });

  it('replaces only the fields the edit names', () => {
    const next = applyEdit(SHIPPED, {
      name: 'Hub',
      url: 'https://ghe.example/',
      description: 'Ours',
      category: 'custom',
    });
    expect(next.name).toBe('Hub');
    expect(next.url).toBe('https://ghe.example/');
    expect(next.description).toBe('Ours');
    expect(next.category).toBe('custom');
    // Everything it did not name still comes from the registry.
    expect(next.keys).toEqual(['gh', 'github']);
    expect(next.searchUrl).toBe(SHIPPED.searchUrl);
    expect(next.example).toBe(SHIPPED.example);
  });

  // SECURITY: an edit arrives from an import file. These four fields choose
  // which handler runs and which override entries the command owns.
  it('ignores handler, provider, builtin and id', () => {
    const next = applyEdit(SHIPPED, {
      handler: 'ai',
      provider: 'chatgpt',
      builtin: false,
      id: 'evil',
      name: 'Mine',
    } as unknown as ShortcutEdit);
    expect(next.handler).toBe('github');
    expect(next.provider).toBeUndefined();
    expect(next.builtin).toBe(true);
    expect(next.id).toBe('gh');
    expect(next.name).toBe('Mine');
  });

  it('does not put undefined-valued keys on the result', () => {
    // A spread of the edit would; copying field by field must not either, or
    // every `toStrictEqual` against a registry entry starts failing.
    expect(applyEdit(SHIPPED, { name: 'Hub' })).toStrictEqual({ ...SHIPPED, name: 'Hub' });
  });

  it('inherits the shipped url when the edit blanks or breaks it', () => {
    // Invariant 12: `rawDestination` returns `cmd.url`, and '' is not a place.
    expect(applyEdit(SHIPPED, { url: '   ' }).url).toBe(SHIPPED.url);
    expect(applyEdit(SHIPPED, { url: 'not a url' }).url).toBe(SHIPPED.url);
    expect(applyEdit(SHIPPED, { url: 'javascript:alert(1)' }).url).toBe(SHIPPED.url);
    expect(applyEdit(SHIPPED, { url: undefined }).url).toBe(SHIPPED.url);
  });

  it('inherits the shipped name when the edit blanks it', () => {
    // A nameless row is unreadable, so the one blankable field is description.
    expect(applyEdit(SHIPPED, { name: '  ' }).name).toBe('GitHub');
    expect(applyEdit(SHIPPED, { description: '  ' }).description).toBe('');
  });

  it('treats an empty keys list as no override', () => {
    expect(applyEdit(SHIPPED, { keys: [] }).keys).toEqual(['gh', 'github']);
    expect(applyEdit(SHIPPED, { keys: ['  ', ''] }).keys).toEqual(['gh', 'github']);
  });

  it('replaces every alias when the edit names keys', () => {
    expect(applyEdit(SHIPPED, { keys: [' hub ', 'octo'] }).keys).toEqual(['hub', 'octo']);
  });

  it('ignores replacement keys the resolver could never match', () => {
    // Through the one validation boundary (invariant 6): `resolve()` strips a
    // leading `\` before the key map is consulted and takes the first token as
    // the keyword, so a shortcut rebound to either of these answers to nothing.
    // Keeping the shipped keys is the same "no override" answer an empty list
    // gets, because an orphaned command is worse than an unapplied edit.
    expect(applyEdit(SHIPPED, { keys: ['\\bad', 'foo bar'] }).keys).toEqual(['gh', 'github']);
    // What survives is kept, lowercased and deduped like every other alias.
    expect(applyEdit(SHIPPED, { keys: ['HUB', 'foo bar', 'hub'] }).keys).toEqual(['hub']);
  });

  it('separates a cleared optional field from an absent one', () => {
    expect(applyEdit(SHIPPED, { searchUrl: null }).searchUrl).toBeUndefined();
    expect('searchUrl' in applyEdit(SHIPPED, { searchUrl: null })).toBe(false);
    expect(applyEdit(SHIPPED, { name: 'Hub' }).searchUrl).toBe(SHIPPED.searchUrl);
    expect(applyEdit(SHIPPED, { example: null }).example).toBeUndefined();
    expect(applyEdit(SHIPPED, { name: 'Hub' }).example).toBe(SHIPPED.example);
  });

  it('keeps a category only when this build has it', () => {
    expect(applyEdit(SHIPPED, { category: ' AI ' }).category).toBe('ai');
    // Dropped rather than coerced to `custom`: a shipped command must not
    // silently relocate to "My shortcuts" because a section vanished.
    expect(applyEdit(SHIPPED, { category: 'nonsense' }).category).toBe('dev');
  });

  it('does not mutate the command it was handed', () => {
    const before = structuredClone(SHIPPED);
    applyEdit(SHIPPED, { keys: ['hub'], name: 'Hub', searchUrl: null });
    expect(SHIPPED).toEqual(before);
  });
});

describe('diffEdit', () => {
  it('is null when nothing differs', () => {
    expect(diffEdit(SHIPPED, { ...SHIPPED })).toBeNull();
  });

  it('emits only the field that moved', () => {
    expect(diffEdit(SHIPPED, { ...SHIPPED, name: 'Hub' })).toEqual({ name: 'Hub' });
  });

  it('emits null for an optional field the user removed', () => {
    const cleared = { ...SHIPPED };
    delete cleared.searchUrl;
    expect(diffEdit(SHIPPED, cleared)).toEqual({ searchUrl: null });
  });

  it('says nothing about an optional field neither side has', () => {
    const bare = { ...SHIPPED };
    delete bare.searchUrl;
    delete bare.example;
    expect(diffEdit(bare, { ...bare })).toBeNull();
  });

  it('compares keys element-wise, order included', () => {
    expect(diffEdit(SHIPPED, { ...SHIPPED, keys: ['github', 'gh'] })).toEqual({
      keys: ['github', 'gh'],
    });
    expect(diffEdit(SHIPPED, { ...SHIPPED, keys: ['GH', 'GitHub'] })).toBeNull();
  });

  it('round trips through applyEdit', () => {
    const next: Command = {
      ...SHIPPED,
      keys: ['hub'],
      name: 'Hub',
      description: '',
      url: 'https://ghe.example/',
      category: 'custom',
      example: 'hub me',
    };
    delete next.searchUrl;
    const edit = diffEdit(SHIPPED, next);
    expect(edit).not.toBeNull();
    expect(applyEdit(SHIPPED, edit ?? undefined)).toStrictEqual(next);
  });

  it('reports no change it could not carry back', () => {
    // `applyEdit` inherits a blank name and an unusable url, so storing them
    // would produce a diff that does not round trip.
    expect(diffEdit(SHIPPED, { ...SHIPPED, name: '   ' })).toBeNull();
    expect(diffEdit(SHIPPED, { ...SHIPPED, url: 'not a url' })).toBeNull();
    expect(diffEdit(SHIPPED, { ...SHIPPED, keys: ['foo bar'] })).toBeNull();
  });

  it('does not turn an unusable searchUrl into a removal', () => {
    // Derived from the registry: `null` here means "the user removed it", so
    // this only says anything about a command that ships one, and `gh` does
    // not. Recording garbage as `null` would delete a searchUrl the user never
    // touched: the one field where "unusable" and "cleared" are different
    // instructions.
    const shipsSearch = BUILTIN_COMMANDS.find((cmd) => cmd.searchUrl);
    if (!shipsSearch) throw new Error('no shipped command carries a searchUrl');
    expect(diffEdit(shipsSearch, { ...shipsSearch, searchUrl: 'not a url' })).toBeNull();
    expect(diffEdit(shipsSearch, { ...shipsSearch, searchUrl: 'javascript:alert(1)' })).toBeNull();
    // A blank one is still the removal it has always been.
    expect(diffEdit(shipsSearch, { ...shipsSearch, searchUrl: '  ' })).toEqual({ searchUrl: null });
  });
});

describe('foldLegacyKeyOverrides', () => {
  it('turns a v1 rebinding into an edit', () => {
    expect(foldLegacyKeyOverrides({}, { gh: ['hub'] })).toEqual({ gh: { keys: ['hub'] } });
  });

  it('lets an explicit edit win over the legacy entry', () => {
    expect(foldLegacyKeyOverrides({ gh: { keys: ['octo'] } }, { gh: ['hub'] })).toEqual({
      gh: { keys: ['octo'] },
    });
  });

  it('keeps the rest of an edit that does not name keys', () => {
    expect(foldLegacyKeyOverrides({ gh: { name: 'Mine' } }, { gh: ['hub'] })).toEqual({
      gh: { name: 'Mine', keys: ['hub'] },
    });
  });

  it('drops an entry that says nothing', () => {
    expect(foldLegacyKeyOverrides({}, { gh: [], '  ': ['x'], 'bad key': ['y'] })).toEqual({});
  });

  it('drops a legacy entry keyed by a user id', () => {
    // The v1 map predates user ids, so such a key is a hand edit, and edits
    // are for shipped shortcuts only. Folding it would put back exactly the
    // entry the storage boundary drops.
    expect(foldLegacyKeyOverrides({}, { 'u:tix': ['ticket'] })).toEqual({});
  });

  it('does not mutate the edits it was handed', () => {
    const edits = { gh: { name: 'Mine' } };
    foldLegacyKeyOverrides(edits, { gh: ['hub'] });
    expect(edits).toEqual({ gh: { name: 'Mine' } });
  });
});

// ------------------------------------------------------------ sections ----

const WORK: Section[] = [{ id: 'sec-work', label: 'Work' }];

function overridesWith(patch: Partial<Overrides>): Overrides {
  return { ...DEFAULT_OVERRIDES, ...patch };
}

describe('knownCategoryIds', () => {
  it('is every shipped category plus the declared sections', () => {
    const known = knownCategoryIds(WORK);
    for (const category of CATEGORIES) expect(known.has(category)).toBe(true);
    expect(known.has('sec-work')).toBe(true);
    expect(known.has('nonsense')).toBe(false);
  });

  it('reads a section id the way storage stored it', () => {
    expect(knownCategoryIds([{ id: '  SEC-WORK ', label: 'Work' }]).has('sec-work')).toBe(true);
  });

  it('survives an absent section list', () => {
    expect(knownCategoryIds(undefined).size).toBe(CATEGORIES.length);
  });
});

describe('sectionLabel', () => {
  it('falls back to the shipped label', () => {
    expect(sectionLabel('dev', [])).toBe('Developer');
    expect(sectionLabel('custom', [])).toBe('My shortcuts');
  });

  it('lets a section entry rename a shipped category', () => {
    expect(sectionLabel('dev', [{ id: 'dev', label: 'Engineering' }])).toBe('Engineering');
  });

  it('names a user section', () => {
    expect(sectionLabel('sec-work', WORK)).toBe('Work');
  });

  it('answers with the id itself when nothing names it', () => {
    expect(sectionLabel('sec-gone', [])).toBe('sec-gone');
  });

  it('does not answer with something off Object.prototype', () => {
    // `validateSectionId` accepts `constructor`, so a section with that id is
    // storable and a bare `CATEGORY_LABELS[id]` lookup would answer with a
    // function.
    expect(validateSectionId('constructor').ok).toBe(true);
    expect(sectionLabel('constructor', [])).toBe('constructor');
    expect(sectionLabel('toString', [])).toBe('tostring');
  });

  it('ignores a section whose label could never be shown', () => {
    expect(sectionLabel('dev', [{ id: 'dev', label: '   ' }])).toBe('Developer');
  });
});

describe('sectionOrder', () => {
  const commands = [
    cmd({ keys: ['tix'], category: 'custom' }),
    cmd({ keys: ['gh'], category: 'dev' }),
    cmd({ keys: ['w'], category: 'sec-work' }),
    cmd({ keys: ['x'], category: 'sec-gone' }),
  ];

  it("leads with the user's own shortcuts, then the shipped order, then sections, then strays", () => {
    expect(sectionOrder(WORK, commands)).toEqual([
      'custom',
      ...CATEGORIES.filter((category) => category !== 'custom'),
      'sec-work',
      'sec-gone',
    ]);
  });

  it('drops the lead when the user has no shortcuts of their own', () => {
    const order = sectionOrder(WORK, [cmd({ keys: ['gh'], category: 'dev' })]);
    expect(order[0]).toBe('ai');
    expect(order).not.toContain('custom');
  });

  it('keeps a declared section that holds nothing, so it can be filled', () => {
    expect(sectionOrder(WORK, [])).toContain('sec-work');
  });

  it('lists each id once, in the order sections were created', () => {
    const sections: Section[] = [
      { id: 'sec-b', label: 'B' },
      { id: 'sec-a', label: 'A' },
      { id: 'dev', label: 'Engineering' },
    ];
    const order = sectionOrder(sections, [cmd({ keys: ['w'], category: 'sec-a' })]);
    expect(order.filter((id) => id === 'dev')).toEqual(['dev']);
    expect(order.slice(-2)).toEqual(['sec-b', 'sec-a']);
  });
});

describe('sectionOptions', () => {
  it('always offers "My shortcuts", even when it holds nothing', () => {
    const options = sectionOptions([], []);
    expect(options[0]).toEqual({ id: 'custom', label: 'My shortcuts' });
  });

  it('carries the labels in browse order', () => {
    const options = sectionOptions(WORK, [cmd({ keys: ['tix'], category: 'custom' })]);
    expect(options[0]).toEqual({ id: 'custom', label: 'My shortcuts' });
    expect(options[options.length - 1]).toEqual({ id: 'sec-work', label: 'Work' });
    expect(options.map((option) => option.id)).toEqual(
      sectionOrder(WORK, [cmd({ keys: ['tix'], category: 'custom' })]),
    );
  });
});

describe('sectionMembers', () => {
  const builtins = [
    cmd({ keys: ['gh'], category: 'dev', builtin: true }),
    cmd({ keys: ['npm'], category: 'dev', builtin: true }),
    cmd({ keys: ['g'], category: 'search', builtin: true }),
  ];

  it('counts a shipped shortcut the user moved, not the one the registry ships there', () => {
    const overrides = overridesWith({
      sections: WORK,
      edits: { gh: { category: 'sec-work' } },
    });
    expect(sectionMembers('sec-work', builtins, overrides)).toEqual(['gh']);
    expect(sectionMembers('dev', builtins, overrides)).toEqual(['npm']);
  });

  it("counts the user's own shortcuts too", () => {
    const overrides = overridesWith({
      sections: WORK,
      custom: [cmd({ id: 'u:tix', keys: ['tix'], category: 'sec-work' })],
    });
    expect(sectionMembers('sec-work', builtins, overrides)).toEqual(['u:tix']);
  });

  it('counts one that is turned off but not one that is deleted', () => {
    const overrides = overridesWith({ disabled: ['gh'], deleted: ['npm'] });
    expect(sectionMembers('dev', builtins, overrides)).toEqual(['gh']);
  });

  it('is empty for a section nothing is filed under', () => {
    expect(sectionMembers('sec-work', builtins, overridesWith({ sections: WORK }))).toEqual([]);
    expect(sectionMembers('  ', builtins, DEFAULT_OVERRIDES)).toEqual([]);
  });
});

describe('newSectionId', () => {
  it('slugifies the label', () => {
    expect(newSectionId('Client work', new Set())).toBe('sec-client-work');
    expect(newSectionId('  Work!!  ', new Set())).toBe('sec-work');
  });

  it('never collides with a shipped category id', () => {
    for (const category of CATEGORIES) {
      expect(newSectionId(CATEGORY_LABELS[category], new Set())).not.toBe(category);
      expect(isShippedSection(newSectionId(category, new Set()))).toBe(false);
    }
  });

  it('suffixes on collision, deterministically', () => {
    const taken = new Set(['sec-work']);
    expect(newSectionId('Work', taken)).toBe('sec-work-2');
    taken.add('sec-work-2');
    expect(newSectionId('Work', taken)).toBe('sec-work-3');
  });

  it('mints an id the validator accepts, however long the label', () => {
    const id = newSectionId('x'.repeat(80), new Set());
    expect(id.length).toBeLessThanOrEqual(MAX_SECTION_ID_LENGTH);
    expect(validateSectionId(id).ok).toBe(true);
    expect(validateSectionId(newSectionId('🙂🙂', new Set())).ok).toBe(true);
  });
});

describe('fitSectionId', () => {
  it('cuts the base so prefix + base + suffix stays inside the cap', () => {
    const id = fitSectionId('x'.repeat(80), '-12', 'sec-');
    expect(id.length).toBe(MAX_SECTION_ID_LENGTH);
    expect(id.startsWith('sec-')).toBe(true);
    expect(id.endsWith('-12')).toBe(true);
    expect(validateSectionId(id).ok).toBe(true);
  });

  it('leaves a base that already fits alone', () => {
    expect(fitSectionId('work', '-2')).toBe('work-2');
    expect(fitSectionId('client-work')).toBe('client-work');
  });

  it('never ends the cut on a dash', () => {
    // A truncation that lands on the dash of `client-work` reads `client--2`.
    const suffix = '-2'.padEnd(MAX_SECTION_ID_LENGTH - 7, 'z');
    expect(fitSectionId('client-work', suffix)).toBe(`client${suffix}`);
  });

  it('falls back to a usable slug when the base has nothing to cut to', () => {
    expect(fitSectionId('', '-2')).toBe('shortcut-2');
  });
});

describe('sectionLabelTaken', () => {
  it('matches a shipped label case-insensitively', () => {
    expect(sectionLabelTaken('developer', [])).toBe(true);
    expect(sectionLabelTaken('  MY SHORTCUTS ', [])).toBe(true);
    expect(sectionLabelTaken('Client work', [])).toBe(false);
  });

  it('matches a user section', () => {
    expect(sectionLabelTaken('work', WORK)).toBe(true);
  });

  it('frees a shipped label the user renamed away from', () => {
    const renamed: Section[] = [{ id: 'dev', label: 'Engineering' }];
    expect(sectionLabelTaken('Developer', renamed)).toBe(false);
    expect(sectionLabelTaken('Engineering', renamed)).toBe(true);
  });

  it("says nothing about a blank label: that is the validator's answer", () => {
    expect(sectionLabelTaken('   ', WORK)).toBe(false);
  });

  describe('with a selfId: the rename question, not the add one', () => {
    it('lets a section keep its own name', () => {
      // Blurring the field without changing it must not refuse the value that
      // is already stored.
      expect(sectionLabelTaken('Work', WORK, 'sec-work')).toBe(false);
      expect(sectionLabelTaken('  WORK ', WORK, 'sec-work')).toBe(false);
      expect(sectionLabelTaken('Engineering', [{ id: 'dev', label: 'Engineering' }], 'dev')).toBe(
        false,
      );
    });

    it('refuses a shipped label no one has renamed away from', () => {
      expect(sectionLabelTaken('Developer', WORK, 'sec-work')).toBe(true);
      expect(sectionLabelTaken('developer', WORK, 'sec-work')).toBe(true);
    });

    it("refuses another user section's label", () => {
      const two: Section[] = [...WORK, { id: 'sec-play', label: 'Play' }];
      expect(sectionLabelTaken('Play', two, 'sec-work')).toBe(true);
      expect(sectionLabelTaken('Client work', two, 'sec-work')).toBe(false);
    });

    it('folds case and width the way the labels themselves are compared', () => {
      // NFKC: the full-width lookalike renders as the same heading.
      expect(sectionLabelTaken('\uff37\uff4f\uff52\uff4b', WORK, 'sec-play')).toBe(true);
      expect(sectionLabelTaken('wOrK', WORK, 'sec-play')).toBe(true);
    });

    it('frees the label the section being renamed used to carry', () => {
      // `dev` is called "Work" here, so nothing else is, and `sec-work` may
      // take it the moment `dev` gives it up. Only the would-produce reading
      // gets this right: "is Work in use, ignoring sec-work" says yes.
      const renamed: Section[] = [
        { id: 'dev', label: 'Work' },
        { id: 'sec-work', label: 'Jobs' },
      ];
      expect(sectionLabelTaken('Work', renamed, 'dev')).toBe(false);
    });

    it('allows restoring a shipped default name that nothing else answers to', () => {
      const renamed: Section[] = [{ id: 'dev', label: 'Hacking' }];
      // Restoring drops the entry, so `dev` falls back to "Developer", and
      // that is the only thing on the list called it.
      expect(sectionLabelTaken('Developer', renamed, 'dev')).toBe(false);
    });

    it('refuses restoring a shipped default name a section has since taken', () => {
      // The shipped bug: rename Developer to Hacking, add a section called
      // Developer, press Restore default name and end up with two headings
      // reading "Developer".
      const clashing: Section[] = [
        { id: 'dev', label: 'Hacking' },
        { id: 'sec-developer', label: 'Developer' },
      ];
      expect(sectionLabelTaken('Developer', clashing, 'dev')).toBe(true);
    });

    it('tolerates the duplicate an import legitimately carried', () => {
      // `mergeOverrides` keeps two ids with one label rather than merging them,
      // so a section that is ALREADY one of a pair may still be renamed to
      // something free.
      const dupes: Section[] = [
        { id: 'sec-work', label: 'Work' },
        { id: 'sec-work-2', label: 'Work' },
      ];
      expect(sectionLabelTaken('Client work', dupes, 'sec-work')).toBe(false);
      expect(sectionLabelTaken('Work', dupes, 'sec-work')).toBe(true);
    });
  });
});

describe('addSection', () => {
  it('appends the section and hands back its id', () => {
    const { overrides, id } = addSection(DEFAULT_OVERRIDES, '  Client work  ');
    expect(id).toBe('sec-client-work');
    expect(overrides.sections).toEqual([{ id: 'sec-client-work', label: 'Client work' }]);
    expect(DEFAULT_OVERRIDES.sections).toEqual([]);
  });

  it('refuses a label nothing could display', () => {
    expect(addSection(DEFAULT_OVERRIDES, '   ').id).toBe('');
    expect(addSection(DEFAULT_OVERRIDES, 'x'.repeat(41)).id).toBe('');
    expect(addSection(DEFAULT_OVERRIDES, '   ').overrides).toBe(DEFAULT_OVERRIDES);
  });

  it('refuses past the cap rather than letting storage drop it silently', () => {
    const full = overridesWith({
      sections: Array.from({ length: MAX_SECTIONS }, (_, n) => ({
        id: `sec-${n}`,
        label: `S${n}`,
      })),
    });
    expect(addSection(full, 'One more').id).toBe('');
    expect(addSection(full, 'One more').overrides).toBe(full);
  });
});

describe('renameSection', () => {
  it('adds an entry that renames a shipped category', () => {
    const next = renameSection(DEFAULT_OVERRIDES, 'dev', 'Engineering');
    expect(next.sections).toEqual([{ id: 'dev', label: 'Engineering' }]);
    expect(sectionLabel('dev', next.sections)).toBe('Engineering');
  });

  it('removes the entry when a shipped category is renamed back', () => {
    const renamed = renameSection(DEFAULT_OVERRIDES, 'dev', 'Engineering');
    expect(renameSection(renamed, 'dev', 'Developer').sections).toEqual([]);
  });

  it('leaves a canonical blob when the rename-back was a no-op', () => {
    expect(renameSection(DEFAULT_OVERRIDES, 'dev', 'Developer')).toBe(DEFAULT_OVERRIDES);
  });

  it('edits a user section in place', () => {
    const overrides = overridesWith({
      sections: [{ id: 'sec-a', label: 'A' }, ...WORK],
    });
    const next = renameSection(overrides, 'sec-work', 'Client work');
    expect(next.sections).toEqual([
      { id: 'sec-a', label: 'A' },
      { id: 'sec-work', label: 'Client work' },
    ]);
  });

  it('refuses a label the validator refuses, and never mutates', () => {
    const overrides = overridesWith({ sections: WORK });
    expect(renameSection(overrides, 'sec-work', '   ')).toBe(overrides);
    expect(renameSection(overrides, '  ', 'Anything')).toBe(overrides);
    expect(overrides.sections).toEqual(WORK);
  });

  it('refuses past the cap when the rename would APPEND an entry', () => {
    // Renaming a shipped group the user has not touched adds a section entry,
    // and an entry over the cap is one the storage boundary drops on the next
    // save: the heading would go back to "Developer" with nothing on the page
    // to say why. Refused the way `addSection` refuses: the same reference back.
    const full = overridesWith({
      sections: Array.from({ length: MAX_SECTIONS }, (_, n) => ({
        id: `sec-${n}`,
        label: `S${n}`,
      })),
    });
    expect(renameSection(full, 'dev', 'Engineering')).toBe(full);
  });

  it('renames in place at the cap, because that appends nothing', () => {
    const full = overridesWith({
      sections: Array.from({ length: MAX_SECTIONS }, (_, n) => ({
        id: `sec-${n}`,
        label: `S${n}`,
      })),
    });
    expect(renameSection(full, 'sec-0', 'Renamed').sections[0]).toEqual({
      id: 'sec-0',
      label: 'Renamed',
    });
    // And dropping an entry to restore a shipped name is always allowed.
    const atCap = overridesWith({
      sections: [
        { id: 'dev', label: 'Hacking' },
        ...Array.from({ length: MAX_SECTIONS - 1 }, (_, n) => ({
          id: `sec-${n}`,
          label: `S${n}`,
        })),
      ],
    });
    expect(renameSection(atCap, 'dev', 'Developer').sections).toHaveLength(MAX_SECTIONS - 1);
  });
});

describe('deleteSection', () => {
  const overrides = overridesWith({
    sections: [...WORK, { id: 'sec-other', label: 'Other' }],
    edits: { gh: { category: 'sec-work' }, npm: { category: 'sec-other' } },
    custom: [
      cmd({ id: 'u:tix', keys: ['tix'], category: 'sec-work' }),
      cmd({ id: 'u:pay', keys: ['pay'], category: 'sec-other' }),
    ],
  });

  it('refuses a shipped id by handing back exactly what it was given', () => {
    // With an ENTRY present for the shipped id, so this is answering "shipped
    // groups can only be renamed" rather than "there is nothing there": a
    // renamed shipped category has a section entry exactly like a user one.
    const renamed = overridesWith({
      sections: [{ id: 'dev', label: 'Engineering' }, ...WORK],
      edits: { gh: { category: 'dev' } },
      custom: [cmd({ id: 'u:tix', keys: ['tix'], category: 'dev' })],
    });
    for (const category of CATEGORIES) {
      expect(deleteSection(renamed, category)).toBe(renamed);
    }
    expect(deleteSection(renamed, '  DEV ')).toBe(renamed);
    expect(deleteSection(overrides, 'custom')).toBe(overrides);
  });

  it('refuses an id no section answers to', () => {
    expect(deleteSection(overrides, 'sec-gone')).toBe(overrides);
    expect(deleteSection(overrides, '')).toBe(overrides);
  });

  it('moves the members in BOTH places and leaves the others alone', () => {
    const next = deleteSection(overrides, 'sec-work');
    expect(next.sections).toEqual([{ id: 'sec-other', label: 'Other' }]);
    expect(next.edits).toEqual({ gh: { category: 'custom' }, npm: { category: 'sec-other' } });
    expect(next.custom.map((entry) => entry.category)).toEqual(['custom', 'sec-other']);
  });

  it('does not mutate the overrides it was handed', () => {
    const before = JSON.stringify(overrides);
    deleteSection(overrides, 'sec-work');
    expect(JSON.stringify(overrides)).toBe(before);
  });

  it('keeps the edits map free of a prototype', () => {
    const next = deleteSection(overrides, 'sec-work');
    expect(Object.getPrototypeOf(next.edits)).toBeNull();
  });
});
