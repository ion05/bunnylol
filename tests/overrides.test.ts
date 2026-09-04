import { describe, expect, it } from 'vitest';
import {
  addSection,
  applyEdit,
  deleteSection,
  diffEdit,
  renameSection,
  sectionLabel,
  sectionOrder,
  shortcutId,
} from '../src/lib/overrides';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { validateSectionId } from '../src/lib/validate';
import { CATEGORIES, DEFAULT_OVERRIDES } from '../src/lib/types';
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

  // SECURITY, invariant 16: an edit arrives from an import file. These four
  // fields choose which handler runs and which override entries the command
  // owns, so an edit may name none of them.
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

  it('inherits the shipped url when the edit blanks or breaks it', () => {
    // Invariant 12: `rawDestination` returns `cmd.url`, and '' is not a place.
    expect(applyEdit(SHIPPED, { url: '   ' }).url).toBe(SHIPPED.url);
    expect(applyEdit(SHIPPED, { url: 'not a url' }).url).toBe(SHIPPED.url);
    expect(applyEdit(SHIPPED, { url: 'javascript:alert(1)' }).url).toBe(SHIPPED.url);
    expect(applyEdit(SHIPPED, { url: undefined }).url).toBe(SHIPPED.url);
  });

  it('replaces every alias when the edit names keys', () => {
    expect(applyEdit(SHIPPED, { keys: [' hub ', 'octo'] }).keys).toEqual(['hub', 'octo']);
  });
});

describe('diffEdit', () => {
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
});

// ------------------------------------------------------------ sections ----

const WORK: Section[] = [{ id: 'sec-work', label: 'Work' }];

function overridesWith(patch: Partial<Overrides>): Overrides {
  return { ...DEFAULT_OVERRIDES, ...patch };
}

describe('sectionLabel', () => {
  it('does not answer with something off Object.prototype', () => {
    // `validateSectionId` accepts `constructor`, so a section with that id is
    // storable and a bare `CATEGORY_LABELS[id]` lookup would answer with a
    // function.
    expect(validateSectionId('constructor').ok).toBe(true);
    expect(sectionLabel('constructor', [])).toBe('constructor');
    expect(sectionLabel('toString', [])).toBe('tostring');
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
});

describe('addSection', () => {
  it('appends the section and hands back its id', () => {
    const { overrides, id } = addSection(DEFAULT_OVERRIDES, '  Client work  ');
    expect(id).toBe('sec-client-work');
    expect(overrides.sections).toEqual([{ id: 'sec-client-work', label: 'Client work' }]);
    expect(DEFAULT_OVERRIDES.sections).toEqual([]);
  });
});

describe('renameSection', () => {
  it('adds an entry that renames a shipped category', () => {
    const next = renameSection(DEFAULT_OVERRIDES, 'dev', 'Engineering');
    expect(next.sections).toEqual([{ id: 'dev', label: 'Engineering' }]);
    expect(sectionLabel('dev', next.sections)).toBe('Engineering');
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

  it('moves the members in BOTH places and leaves the others alone', () => {
    const next = deleteSection(overrides, 'sec-work');
    expect(next.sections).toEqual([{ id: 'sec-other', label: 'Other' }]);
    expect(next.edits).toEqual({ gh: { category: 'custom' }, npm: { category: 'sec-other' } });
    expect(next.custom.map((entry) => entry.category)).toEqual(['custom', 'sec-other']);
  });
});
