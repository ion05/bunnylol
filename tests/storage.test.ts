import { describe, expect, it } from 'vitest';
import { at } from './helpers/at';
import { applyImport, exportJson, importJson } from '../src/lib/storage';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { buildKeyMap, mergeCommands } from '../src/lib/resolve';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS, FALLBACK_SECTION } from '../src/lib/types';
import type { Overrides, ShortcutEdit, StoredState } from '../src/lib/types';

const STATE: StoredState = {
  overrides: {
    disabled: ['gh', 'npm'],
    deleted: ['grok'],
    edits: { lh: { keys: ['local', 'l'] }, g: { name: 'Web search', searchUrl: null } },
    sections: [{ id: 'work', label: 'Work' }],
    custom: [
      {
        id: 'u:tix',
        keys: ['tix', 'tickets'],
        name: 'Tickets',
        description: 'Internal ticket tracker',
        url: 'https://tix.example/',
        searchUrl: 'https://tix.example/search?q={q}',
        category: 'custom',
        builtin: false,
        example: 'tix 4821',
      },
    ],
    enabledCategories: ['search', 'dev', 'ai', 'meta'],
    seenBuiltins: ['gh', 'npm', 'g'],
  },
  settings: {
    githubUser: 'octocat',
    defaultEngine: 'https://kagi.com/search?q={q}',
    interceptEngines: ['google', 'duckduckgo'],
    aiTemplates: { chatgpt: 'https://chatgpt.com/?prompt={q}' },
    googleAccount: 2,
    interceptStopList: ['new', 'r'],
    dispatchToast: true,
  },
};

describe('exportJson / importJson round trip', () => {
  it('returns exactly what went in', () => {
    expect(importJson(exportJson(STATE))).toEqual(STATE);
  });
});

describe('importJson leniency', () => {
  it('prunes deleted to ids this build actually ships', () => {
    // `deleted` hides a shipped command. An id no build ever shipped hides
    // nothing, and a `u:` id names a custom command, which is removed by not
    // being in the file at all: keeping either would grow a list of ghosts
    // that nothing on the page could ever clear.
    expect(
      importJson('{"overrides":{"deleted":["gh","no-such-command","u:tix"]}}').overrides.deleted,
    ).toEqual(['gh']);
  });

  it('drops an edit keyed by a user id instead of refusing the file', () => {
    // Edits are for shipped shortcuts; a custom command is edited in place. So
    // this entry is inert, and inert is not wrong, but its `keys` would refuse
    // the file on a shipped id, which means it must not be checked at all.
    const state = importJson(
      '{"overrides":{"edits":{"u:tix":{"keys":["foo bar"]},"gh":{"name":"Mine"}}}}',
    );
    expect(state.overrides.edits).toEqual({ gh: { name: 'Mine' } });
  });

  it("files a v1 export's media shortcut under My shortcuts instead of refusing it", () => {
    // `media` was a shipped category until v1.1.0. Refusing the file would make
    // every v1.0.0 backup that used it unimportable, and the only fix on offer
    // would be hand-editing JSON the user did not write.
    const state = importJson(
      '{"version":1,"overrides":{"custom":[{"keys":["yt"],"url":"https://youtube.com/","category":"media"}]}}',
    );
    expect(at(state.overrides.custom, 0).category).toBe(FALLBACK_SECTION);
  });

  it('mints a stable id for custom commands that have none', () => {
    const state = importJson(
      JSON.stringify({
        overrides: {
          custom: [
            { keys: ['tix'], url: 'https://tix.example/' },
            { keys: ['tix2'], name: 'Tickets', url: 'https://tix.example/2' },
          ],
        },
      }),
    );
    expect(state.overrides.custom.map((cmd) => cmd.id)).toEqual(['u:tix', 'u:tix2']);
  });
});

/**
 * F3/F4: what an import file is allowed to persist.
 *
 * Both failures here were silent. An alias with a space in it was stored and
 * then never matched, because the resolver splits the query at the first
 * whitespace; a `defaultEngine` that is not a URL was stored and then broke
 * EVERY unmatched query, because `toNavigableUrl` reads a scheme-less string as
 * an extension-relative path. A file that says something impossible now gets
 * refused with a message naming the field.
 */
describe('sections and the categories filed against them', () => {
  it('files a shortcut under "custom" when the STORED blob lost the section', () => {
    const orphaned = exportJson({
      overrides: {
        ...DEFAULT_OVERRIDES,
        custom: [
          {
            keys: ['w'],
            name: 'W',
            description: '',
            url: 'https://w.test/',
            category: 'sec-work',
            builtin: false,
          },
        ],
      },
      settings: DEFAULT_SETTINGS,
    });
    expect(JSON.parse(orphaned).overrides.custom[0].category).toBe('custom');
  });

  it('an edit whose category names no section loses the category, not the command', () => {
    const blob = exportJson({
      overrides: { ...DEFAULT_OVERRIDES, edits: { gh: { category: 'ghost', name: 'Mine' } } },
      settings: DEFAULT_SETTINGS,
    });
    expect(JSON.parse(blob).overrides.edits).toEqual({ gh: { name: 'Mine' } });
  });
});

describe('an import that could never work', () => {
  // The strict boundary. An import that would corrupt the profile is refused by
  // name rather than half-applied, and the message names the field so the user
  // can fix the file. A few representative shapes, one per rule; the exhaustive
  // sweep lived here once and said nothing the first row does not.
  it('refuses a file it cannot use and names the field', () => {
    const rejected: Array<[string, RegExp]> = [
      ['{"overrides":{"custom":[{"keys":["foo bar"],"url":"https://x.test/"}]}}', /space/i],
      ['{"overrides":{"keyOverrides":{"gh":["foo bar"]}}}', /keyOverrides\.gh/],
      [
        '{"overrides":{"custom":[{"keys":["x"],"url":"javascript:alert(1)"}]}}',
        /"url" BunnyLol will not open/,
      ],
      [
        '{"overrides":{"custom":[{"keys":["x"],"url":"https://x.test/","category":7}]}}',
        /The "category" of shortcut "x" must be a string/,
      ],
      [
        '{"overrides":{"custom":[{"keys":["x"],"url":"https://x.test/","id":"gh"}]}}',
        /Shortcut "x" claims the id "gh"/,
      ],
      ['{"settings":{"defaultEngine":"not a url"}}', /settings\.defaultEngine/],
      ['not json at all', /./],
    ];
    for (const [input, pattern] of rejected) {
      let thrown: unknown;
      try {
        importJson(input);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, input).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message, input).toMatch(pattern);
      expect(message, input).not.toMatch(/undefined|\[object Object\]/);
    }
  });
});

/**
 * The lenient half of the same boundary. Already-stored state goes through
 * `normalizeState`, which must never throw: a blob written by an older build,
 * or half-written by an interrupted save, has to degrade to something usable or
 * the extension is bricked on every surface at once.
 */
describe('lenient recovery from a corrupt stored blob', () => {
  const corrupt = {
    overrides: {
      disabled: ['gh', 'foo bar'],
      deleted: ['grok', 'foo bar', 'no-such-command'],
      keyOverrides: { lh: ['local', 'foo bar'], 'bad key': ['x'] },
      edits: {
        gh: { url: 'not a url', name: 'Mine' },
        'bad id': { name: 'x' },
        npm: { url: 'javascript:alert(1)' },
        tix: {},
        'u:tix': { name: 'Mine too' },
      },
      sections: [
        { id: 'work', label: 'Work' },
        { id: 'my work', label: 'x' },
        { id: 'work', label: 'Twin' },
      ],
      custom: [
        { keys: ['foo bar'], url: 'https://x.test/' },
        { keys: ['tix'], url: 'not a url' },
        { keys: ['ok'], url: 'https://ok.test/', searchUrl: 'javascript:alert(1)' },
      ],
    },
    settings: { defaultEngine: 'not a url', aiTemplates: { claude: 'nonsense' } },
  };

  /**
   * `exportJson` normalizes on the way out, which is the same code path
   * `loadState` runs on the way in, so this asserts the recovery without
   * needing a `chrome.storage` stub.
   */
  const recovered = JSON.parse(exportJson(corrupt as unknown as StoredState));

  it('drops what it cannot use instead of throwing', () => {
    expect(recovered.overrides.disabled).toEqual(['gh']);
    expect(recovered.overrides.custom.map((cmd: { keys: string[] }) => cmd.keys[0])).toEqual([
      'ok',
    ]);
    expect(recovered.overrides.custom[0].searchUrl).toBeUndefined();
  });
});

describe('applyImport', () => {
  it('replaces the overrides wholesale, which is what "Replace everything" means', () => {
    const current = { overrides: STATE.overrides, settings: STATE.settings };
    const merged = applyImport(importJson('{"overrides":{"custom":[]}}'), current);
    expect(merged.overrides.custom).toEqual([]);
    expect(merged.overrides.disabled).toEqual([]);
    // ...but a file with no "settings" key still leaves the user's settings be.
    expect(merged.settings).toEqual(STATE.settings);
  });
});

/**
 * The format-1 reader. `keyOverrides` was the only place a v1 file recorded a
 * rebinding, so losing it would silently un-rebind every keyword the user
 * changed: the failure they would notice last and trust least.
 */
describe('a format 1 file', () => {
  it('is accepted and its keyOverrides arrive as an edit', () => {
    const state = importJson('{"version":1,"overrides":{"keyOverrides":{"gh":["hub"]}}}');
    expect(state.overrides.edits.gh?.keys).toEqual(['hub']);
    expect(
      mergeCommands(BUILTIN_COMMANDS, state.overrides).find((cmd) => cmd.id === 'gh')?.keys,
    ).toEqual(['hub']);
  });

  it('refuses a format 3 file', () => {
    expect(() => importJson('{"version":3,"overrides":{}}')).toThrow(/newer version/i);
  });
});

/**
 * SECURITY. `handler`, `provider`, `builtin` and `id` select behaviour and
 * identity. An import file is untrusted input, so the whole path from JSON to
 * resolved command is driven here rather than asserting on `applyEdit` alone.
 */
describe('an edit cannot smuggle behaviour through the import', () => {
  it('holds even when the edit reaches the merge unparsed', () => {
    // The storage boundary strips these fields, so the two cases above stay
    // green even if `applyEdit` spread the edit onto the command. The merge is
    // the second lock, and this is the only place that turns it: an override
    // blob handed straight to `mergeCommands`: a stored blob written by an
    // older build, or the options page's own in-memory state.
    const overrides: Overrides = {
      ...DEFAULT_OVERRIDES,
      edits: {
        gh: {
          handler: 'ai',
          provider: 'chatgpt',
          builtin: false,
          id: 'evil',
          name: 'Mine',
        } as unknown as ShortcutEdit,
      },
    };
    const gh = buildKeyMap(mergeCommands(BUILTIN_COMMANDS, overrides)).get('gh');
    expect(gh?.handler).toBe('github');
    expect(gh?.provider).toBeUndefined();
    expect(gh?.builtin).toBe(true);
    expect(gh?.id).toBe('gh');
    expect(gh?.name).toBe('Mine');
  });
});

describe('deleting a shipped shortcut', () => {
  const state = importJson('{"overrides":{"deleted":["gh"],"edits":{"gh":{"name":"Mine"}}}}');

  it('keeps the edit, so restoring it restores what the user had', () => {
    expect(state.overrides.edits.gh).toEqual({ name: 'Mine' });
  });
});
