import { describe, expect, it } from 'vitest';
import { applyImport, exportJson, importJson } from '../src/lib/storage';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { buildKeyMap, mergeCommands } from '../src/lib/resolve';
import { restorableShipped } from '../src/lib/overrides';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS, DEFAULT_STOP_LIST } from '../src/lib/types';
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
  },
  settings: {
    githubUser: 'octocat',
    defaultEngine: 'https://kagi.com/search?q={q}',
    defaultAi: 'gpt',
    interceptEngines: ['google', 'duckduckgo'],
    aiTemplates: { chatgpt: 'https://chatgpt.com/?prompt={q}' },
    googleAccount: 2,
    interceptStopList: ['new', 'r'],
    dispatchToast: true,
  },
};

describe('exportJson', () => {
  it('emits pretty-printed, versioned JSON holding only the user layer', () => {
    const parsed = JSON.parse(exportJson(STATE));
    expect(parsed.version).toBe(2);
    expect(Object.keys(parsed).sort()).toEqual(['overrides', 'settings', 'version']);
    expect(exportJson(STATE)).toContain('\n  ');
  });

  it('normalizes a state that never went through storage', () => {
    const parsed = JSON.parse(exportJson({} as StoredState));
    expect(parsed.overrides).toEqual(DEFAULT_OVERRIDES);
    expect(parsed.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('exportJson / importJson round trip', () => {
  it('returns exactly what went in', () => {
    expect(importJson(exportJson(STATE))).toEqual(STATE);
  });

  it('is stable across a second round trip', () => {
    const once = applyImport(importJson(exportJson(STATE)), STATE);
    expect(applyImport(importJson(exportJson(once)), STATE)).toEqual(once);
  });

  it('round trips the defaults', () => {
    const defaults: StoredState = { overrides: DEFAULT_OVERRIDES, settings: DEFAULT_SETTINGS };
    expect(importJson(exportJson(defaults))).toEqual(defaults);
  });
});

describe('importJson rejections', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['an empty string', '', /empty/i],
    ['whitespace only', '   \n ', /empty/i],
    ['a non-string', 42, /empty/i],
    ['unparseable text', '{not json at all', /not valid JSON/i],
    ['a JSON array', '[1, 2, 3]', /top level/i],
    ['a JSON scalar', '"hello"', /top level/i],
    ['an object with no BunnyLol data', '{"hello":"world"}', /no BunnyLol data/i],
    ['a non-object overrides', '{"overrides":"nope"}', /"overrides" must be an object/i],
    ['a non-object settings', '{"settings":[]}', /"settings" must be an object/i],
    ['a newer format version', '{"version":99,"overrides":{}}', /newer version/i],
    ['a non-array disabled list', '{"overrides":{"disabled":"gh"}}', /"disabled" must be an array/i],
    ['a non-object keyOverrides', '{"overrides":{"keyOverrides":[]}}', /"keyOverrides" must be an object/i],
    ['a non-array custom list', '{"overrides":{"custom":{}}}', /"custom" must be an array/i],
    ['a custom entry that is not an object', '{"overrides":{"custom":["gh"]}}', /Shortcut #1 is not a JSON object/],
    ['a custom entry with no keys', '{"overrides":{"custom":[{"url":"https://x.test/"}]}}', /no keyword/i],
    ['a custom entry with no url', '{"overrides":{"custom":[{"keys":["x"]}]}}', /missing its "url"/i],
    [
      'a custom entry with a non-string searchUrl',
      '{"overrides":{"custom":[{"keys":["x"],"url":"https://x.test/","searchUrl":7}]}}',
      /"searchUrl" that is not a string/i,
    ],
    [
      'a custom entry with a scheme we refuse to open',
      '{"overrides":{"custom":[{"keys":["x"],"url":"javascript:alert(1)"}]}}',
      /will not open/i,
    ],
  ];

  it.each(cases)('rejects %s with a readable message', (_label, input, pattern) => {
    let thrown: unknown;
    try {
      importJson(input as string);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(pattern);
    expect(message).not.toMatch(/undefined|\[object Object\]/);
    expect(message.length).toBeGreaterThan(10);
  });
});

describe('importJson leniency', () => {
  it('accepts a bare Overrides object and reports absent settings as null', () => {
    const state = importJson(
      JSON.stringify({
        disabled: ['gh'],
        keyOverrides: { lh: ['l'] },
        custom: [{ keys: ['tix'], url: 'https://tix.example/' }],
      }),
    );
    // Null, not defaults: `applyImport` must keep whatever the user has now.
    expect(state.settings).toBeNull();
    expect(state.overrides.disabled).toEqual(['gh']);
    // Format 1's rebinding map arrives as an edit; there is one writer for keys.
    expect(state.overrides.edits).toEqual({ lh: { keys: ['l'] } });
    expect(state.overrides.custom[0].keys).toEqual(['tix']);
  });

  it('prunes deleted to ids this build actually ships', () => {
    // `deleted` hides a shipped command. An id no build ever shipped hides
    // nothing, and a `u:` id names a custom command, which is removed by not
    // being in the file at all — keeping either would grow a list of ghosts
    // that "Restore shipped shortcuts" then has to explain.
    expect(
      importJson('{"overrides":{"deleted":["gh","no-such-command","u:tix"]}}').overrides.deleted,
    ).toEqual(['gh']);
  });

  it('drops an edit keyed by a user id instead of refusing the file', () => {
    // Edits are for shipped shortcuts; a custom command is edited in place. So
    // this entry is inert, and inert is not wrong — but its `keys` would refuse
    // the file on a shipped id, which means it must not be checked at all.
    const state = importJson(
      '{"overrides":{"edits":{"u:tix":{"keys":["foo bar"]},"gh":{"name":"Mine"}}}}',
    );
    expect(state.overrides.edits).toEqual({ gh: { name: 'Mine' } });
  });

  it('accepts a settings-only file', () => {
    const state = importJson('{"settings":{"githubUser":"octocat"}}');
    expect(state.settings?.githubUser).toBe('octocat');
    expect(state.settings?.defaultEngine).toBe(DEFAULT_SETTINGS.defaultEngine);
    expect(state.overrides).toEqual(DEFAULT_OVERRIDES);
  });

  it('accepts the current format version', () => {
    expect(() => importJson('{"version":2,"overrides":{},"settings":{}}')).not.toThrow();
  });

  it('strips builtin:true from imported custom commands', () => {
    const state = importJson(
      JSON.stringify({
        overrides: {
          custom: [
            { keys: ['gh'], name: 'Fake GitHub', url: 'https://evil.example/', builtin: true, category: 'dev' },
          ],
        },
      }),
    );
    expect(state.overrides.custom[0].builtin).toBe(false);
    // The rest of the entry survives; only the builtin claim is refused.
    expect(state.overrides.custom[0].name).toBe('Fake GitHub');
    expect(state.overrides.custom[0].category).toBe('dev');
  });

  it('normalizes keys, category and missing fields on a custom command', () => {
    const state = importJson(
      JSON.stringify({
        overrides: {
          custom: [{ keys: ['  TiX  ', 'tix', ''], url: '  https://tix.example/  ', category: 'nonsense' }],
        },
      }),
    );
    const custom = state.overrides.custom[0];
    expect(custom.keys).toEqual(['tix']);
    expect(custom.url).toBe('https://tix.example/');
    expect(custom.name).toBe('tix');
    expect(custom.description).toBe('');
    expect(custom.category).toBe('custom');
    expect(custom.searchUrl).toBeUndefined();
  });

  it('discards settings values it does not recognize', () => {
    const state = importJson(
      JSON.stringify({
        settings: {
          githubUser: 42,
          interceptEngines: ['google', 'google', 'yahoo'],
          googleAccount: -1,
        },
      }),
    );
    expect(state.settings?.githubUser).toBe('');
    expect(state.settings?.interceptEngines).toEqual(['google']);
    expect(state.settings?.googleAccount).toBe(DEFAULT_SETTINGS.googleAccount);
  });

  it('drops keyOverride entries with no replacement aliases', () => {
    const state = importJson('{"overrides":{"keyOverrides":{"gh":[],"lh":["l"],"  ":["x"]}}}');
    expect(state.overrides.edits).toEqual({ lh: { keys: ['l'] } });
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

  it('assigns the same ids on a second normalization', () => {
    const once = importJson('{"overrides":{"custom":[{"keys":["tix"],"url":"https://tix.example/"}]}}');
    const twice = importJson(exportJson({ overrides: once.overrides, settings: DEFAULT_SETTINGS }));
    expect(twice.overrides.custom[0].id).toBe('u:tix');
  });

  it('gives two shortcuts with the same keyword different ids', () => {
    const state = importJson(
      JSON.stringify({
        overrides: {
          custom: [
            { keys: ['tix'], url: 'https://tix.example/' },
            { keys: ['tix'], url: 'https://tix.example/2' },
          ],
        },
      }),
    );
    expect(state.overrides.custom.map((cmd) => cmd.id)).toEqual(['u:tix', 'u:tix-2']);
  });

  it('re-mints a user id a sibling already claimed', () => {
    const state = importJson(
      JSON.stringify({
        overrides: {
          custom: [
            { keys: ['tix'], url: 'https://tix.example/', id: 'u:tix' },
            { keys: ['tickets'], url: 'https://tix.example/2', id: 'u:tix' },
          ],
        },
      }),
    );
    // Two shortcuts on one id would share every override entry keyed by it.
    expect(state.overrides.custom.map((cmd) => cmd.id)).toEqual(['u:tix', 'u:tickets']);
  });

  it('lets a claimed id beat an id-less sibling that would have minted it', () => {
    const state = importJson(
      JSON.stringify({
        overrides: {
          custom: [
            { keys: ['tix'], url: 'https://tix.example/' },
            { keys: ['zed'], url: 'https://tix.example/2', id: 'u:tix' },
          ],
        },
      }),
    );
    // The claim is reserved before anything mints, so the shortcut that owns
    // `u:tix` — and every override entry keyed by it — keeps it wherever it
    // sits in the file. Minting in list order would hand it to the first entry.
    expect(state.overrides.custom.map((cmd) => cmd.id)).toEqual(['u:tix-2', 'u:tix']);
  });

  it('keeps a user id across a key edit', () => {
    const state = importJson(
      '{"overrides":{"custom":[{"keys":["tickets"],"url":"https://tix.example/","id":"u:tix"}]}}',
    );
    expect(state.overrides.custom[0].id).toBe('u:tix');
  });

  it('mints over an id that is not a string', () => {
    // Not a claim but a type error, and this reader forgives those; only a
    // written id it cannot honour is worth refusing the file over.
    const state = importJson(
      '{"overrides":{"custom":[{"keys":["tix"],"url":"https://tix.example/","id":42}]}}',
    );
    expect(state.overrides.custom[0].id).toBe('u:tix');
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
describe('an import that could never work', () => {
  const rejected: Array<[string, string, RegExp]> = [
    [
      'a keyword with a space in it',
      '{"overrides":{"custom":[{"keys":["foo bar"],"url":"https://x.test/"}]}}',
      /space/i,
    ],
    [
      'a keyword with a space among valid ones',
      '{"overrides":{"custom":[{"keys":["ok","foo bar"],"url":"https://x.test/"}]}}',
      /space/i,
    ],
    [
      'a rebinding to a keyword with a space',
      '{"overrides":{"keyOverrides":{"gh":["foo bar"]}}}',
      /keyOverrides\.gh/,
    ],
    [
      'a rebinding of a keyword with a space',
      '{"overrides":{"keyOverrides":{"foo bar":["x"]}}}',
      /keyOverrides/,
    ],
    [
      'a rebinding whose replacements are not a list',
      '{"overrides":{"keyOverrides":{"gh":"x"}}}',
      /keyOverrides\.gh/,
    ],
    [
      'an edit rebinding to a keyword with a space',
      '{"overrides":{"edits":{"gh":{"keys":["foo bar"]}}}}',
      /"edits\.gh\.keys"/,
    ],
    [
      'an edit whose keys are not a list',
      '{"overrides":{"edits":{"gh":{"keys":"hub"}}}}',
      /"edits\.gh\.keys"/,
    ],
    [
      'an edit whose url is not a url',
      '{"overrides":{"edits":{"gh":{"url":"not a url"}}}}',
      /"edits\.gh\.url"/,
    ],
    [
      'an edit whose searchUrl is not a url',
      '{"overrides":{"edits":{"gh":{"searchUrl":"github.com/search?q={q}"}}}}',
      /"edits\.gh\.searchUrl"/,
    ],
    [
      'an edit keyed by something that could never be an id',
      '{"overrides":{"edits":{"foo bar":{"name":"x"}}}}',
      /"edits" has a shortcut id/,
    ],
    [
      'an edit that is not an object',
      '{"overrides":{"edits":{"gh":"hub"}}}',
      /"edits\.gh" must be an object/,
    ],
    [
      'an edits map that is not an object',
      '{"overrides":{"edits":[]}}',
      /"edits" must be an object/,
    ],
    [
      'a deleted list that is not an array',
      '{"overrides":{"deleted":{}}}',
      /"deleted" must be an array/,
    ],
    [
      'two edits whose ids collide once lowercased',
      '{"overrides":{"edits":{"GH":{"name":"Mine"},"gh":{"name":"Theirs"}}}}',
      /"edits" names the shortcut "gh" twice/,
    ],
    [
      'a section entry that is not an object',
      '{"overrides":{"sections":[["work"]]}}',
      /"sections" has an entry that is not a JSON object/,
    ],
    [
      'more sections than BunnyLol keeps',
      `{"overrides":{"sections":${JSON.stringify(
        Array.from({ length: 65 }, (_, i) => ({ id: `s${i}`, label: `S${i}` })),
      )}}}`,
      /"sections" has 65 entries — BunnyLol keeps at most 64/,
    ],
    [
      'a section id that is not a slug',
      '{"overrides":{"sections":[{"id":"my work","label":"x"}]}}',
      /"sections" has an id that/,
    ],
    [
      'a section with no visible label',
      '{"overrides":{"sections":[{"id":"work","label":"  "}]}}',
      /"sections\.work\.label"/,
    ],
    [
      'a sections list that is not an array',
      '{"overrides":{"sections":{}}}',
      /"sections" must be an array/,
    ],
    [
      'a custom command claiming a shipped id',
      '{"overrides":{"custom":[{"keys":["x"],"url":"https://x.test/","id":"gh"}]}}',
      // Named by its keyword like every other message here — `gh` is the
      // offence, not the entry — and by the rule it broke, since `gh` is only
      // one of infinitely many ids outside the `u:` namespace.
      /Shortcut "x" claims the id "gh", which is reserved for shipped shortcuts/,
    ],
    [
      'a custom command claiming an id outside the user namespace',
      '{"overrides":{"custom":[{"keys":["x"],"url":"https://x.test/","id":"not-shipped-yet"}]}}',
      /Shortcut "x" claims the id "not-shipped-yet"/,
    ],
    [
      'a custom command claiming an id no minting could have produced',
      '{"overrides":{"custom":[{"keys":["x"],"url":"https://x.test/","id":"u:has space"}]}}',
      // Malformed, so it is not a user id either: re-minting it here would
      // import clean under a different id than the one the user hand-wrote.
      // Refused for a different reason than a shipped claim, and said so —
      // this id IS in the `u:` namespace.
      /Shortcut "x" has an "id" BunnyLol cannot use: "u:has space"/,
    ],
    [
      'a custom command claiming an over-long id',
      `{"overrides":{"custom":[{"keys":["x"],"url":"https://x.test/","id":"u:${'y'.repeat(40)}"}]}}`,
      /cannot use: "u:y+"/,
    ],
    [
      'a keyword past the length cap',
      `{"overrides":{"custom":[{"keys":["${'x'.repeat(33)}"],"url":"https://x.test/"}]}}`,
      /32 characters/,
    ],
    [
      'a url that is not a url',
      '{"overrides":{"custom":[{"keys":["x"],"url":"not a url"}]}}',
      /"url" BunnyLol will not open/,
    ],
    [
      'a searchUrl that is not a url',
      '{"overrides":{"custom":[{"keys":["x"],"url":"https://x.test/","searchUrl":"tix.example/?q={q}"}]}}',
      /"searchUrl" BunnyLol will not open/,
    ],
    [
      'a mailto destination no surface can open',
      '{"overrides":{"custom":[{"keys":["x"],"url":"mailto:someone@x.test"}]}}',
      /"url" BunnyLol will not open/,
    ],
    [
      'a defaultEngine that is not a url',
      '{"settings":{"defaultEngine":"not a url"}}',
      /settings\.defaultEngine/,
    ],
    [
      'a defaultEngine with a scheme we refuse',
      '{"settings":{"defaultEngine":"javascript:alert(1)"}}',
      /settings\.defaultEngine/,
    ],
    [
      'an AI template that is not a url',
      '{"settings":{"aiTemplates":{"claude":"data:text/html,x"}}}',
      /settings\.aiTemplates\.claude/,
    ],
    [
      'an aiTemplates that is not an object',
      '{"settings":{"aiTemplates":["https://x.test/?q={q}"]}}',
      /settings\.aiTemplates/,
    ],
  ];

  it.each(rejected)('refuses %s and names the field', (_label, input, pattern) => {
    let thrown: unknown;
    try {
      importJson(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(pattern);
    expect(message).not.toMatch(/undefined|\[object Object\]/);
  });

  it('still accepts the shapes that do work', () => {
    expect(() =>
      importJson(
        JSON.stringify({
          overrides: {
            custom: [
              { keys: ['tix', 'ticket-2'], url: 'https://tix.example/', searchUrl: 'https://tix.example/?q={q}' },
            ],
            keyOverrides: { lh: ['local'] },
            deleted: ['grok'],
            edits: { gh: { keys: ['hub'], name: 'Hub', searchUrl: null, example: null } },
            sections: [{ id: 'work', label: 'Work' }],
          },
          settings: { defaultEngine: 'https://kagi.com/search?q=%s', aiTemplates: { claude: 'https://c.test/?q={q}' } },
        }),
      ),
    ).not.toThrow();
  });
});

/**
 * The lenient half of the same boundary. Already-stored state goes through
 * `normalizeState`, which must never throw — a blob written by an older build,
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
      sections: [{ id: 'work', label: 'Work' }, { id: 'my work', label: 'x' }, { id: 'work', label: 'Twin' }],
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
   * `loadState` runs on the way in — so this asserts the recovery without
   * needing a `chrome.storage` stub.
   */
  const recovered = JSON.parse(exportJson(corrupt as unknown as StoredState));

  it('re-mints a stored custom command whose id could not have been minted', () => {
    const state = JSON.parse(
      exportJson({
        overrides: {
          custom: [{ keys: ['x'], url: 'https://x.test/', id: 'u:has space' }],
        },
      } as unknown as StoredState),
    );
    expect(state.overrides.custom[0].id).toBe('u:x');
  });

  it('re-mints a stored custom command that claims a shipped id', () => {
    // The stored path cannot refuse — refusing here would brick every surface —
    // so the claim is overwritten instead. `gh` keeps its own override entries.
    const state = JSON.parse(
      exportJson({
        overrides: {
          custom: [{ keys: ['x'], url: 'https://x.test/', id: 'gh' }],
        },
      } as unknown as StoredState),
    );
    expect(state.overrides.custom[0].id).toBe('u:x');
  });

  it('drops what it cannot use instead of throwing', () => {
    expect(recovered.overrides.disabled).toEqual(['gh']);
    expect(recovered.overrides.custom.map((cmd: { keys: string[] }) => cmd.keys[0])).toEqual(['ok']);
    expect(recovered.overrides.custom[0].searchUrl).toBeUndefined();
  });

  it('keeps the usable half of an edit and drops the rest', () => {
    expect(recovered.overrides.edits).toEqual({
      // The url is prose and dies here rather than at the merge layer; the name
      // beside it is fine and survives.
      gh: { name: 'Mine' },
      // A key nothing could look up again, an edit with nothing in it, a
      // `javascript:` destination and an edit on a user id: all gone.
      lh: { keys: ['local'] },
    });
  });

  it('prunes deleted down to shortcuts this build actually ships', () => {
    // A tombstone for a command that no longer exists is a shortcut nobody can
    // restore, so it is not kept forever.
    expect(recovered.overrides.deleted).toEqual(['grok']);
  });

  it('keeps only well-formed, unique sections', () => {
    expect(recovered.overrides.sections).toEqual([{ id: 'work', label: 'Work' }]);
  });

  it('spends the section cap on sections it can actually use', () => {
    // A blob padded with junk ahead of a real section: capping the input before
    // filtering would read nothing but the junk and drop every usable section
    // behind it.
    const padded = [
      ...Array.from({ length: 64 }, () => ({ id: 'not a slug', label: 'x' })),
      { id: 'work', label: 'Work' },
    ];
    const state = JSON.parse(
      exportJson({ overrides: { sections: padded } } as unknown as StoredState),
    );
    expect(state.overrides.sections).toEqual([{ id: 'work', label: 'Work' }]);
  });

  it('still stops at the cap once the unusable entries are gone', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ id: `s${i}`, label: `S${i}` }));
    const state = JSON.parse(
      exportJson({ overrides: { sections: many } } as unknown as StoredState),
    );
    expect(state.overrides.sections).toHaveLength(64);
    expect(state.overrides.sections[63]).toEqual({ id: 's63', label: 'S63' });
  });

  it('falls back to the shipped default engine rather than breaking every search', () => {
    expect(recovered.settings.defaultEngine).toBe(DEFAULT_SETTINGS.defaultEngine);
    expect(recovered.settings.aiTemplates).toEqual({});
  });
});

describe('applyImport', () => {
  const CURRENT = {
    overrides: DEFAULT_OVERRIDES,
    settings: { ...DEFAULT_SETTINGS, githubUser: 'octocat', googleAccount: 3 },
  };

  it('keeps the current settings when the file carried none', () => {
    const merged = applyImport(importJson('{"overrides":{"disabled":["gh"]}}'), CURRENT);
    expect(merged.settings).toEqual(CURRENT.settings);
    expect(merged.overrides.disabled).toEqual(['gh']);
  });

  it('takes the imported settings when the file had them', () => {
    const merged = applyImport(importJson('{"settings":{"githubUser":"torvalds"}}'), CURRENT);
    expect(merged.settings.githubUser).toBe('torvalds');
    expect(merged.settings.googleAccount).toBe(DEFAULT_SETTINGS.googleAccount);
  });

  it('replaces the overrides wholesale, which is what "Replace everything" means', () => {
    const current = { overrides: STATE.overrides, settings: STATE.settings };
    const merged = applyImport(importJson('{"overrides":{"custom":[]}}'), current);
    expect(merged.overrides.custom).toEqual([]);
    expect(merged.overrides.disabled).toEqual([]);
    // ...but a file with no "settings" key still leaves the user's settings be.
    expect(merged.settings).toEqual(STATE.settings);
  });

  it('does not mutate the state it was handed', () => {
    const current: StoredState = JSON.parse(JSON.stringify(STATE));
    const snapshot = JSON.stringify(current);
    applyImport(importJson('{"overrides":{"disabled":["npm"]},"settings":{"googleAccount":9}}'), current);
    expect(JSON.stringify(current)).toBe(snapshot);
  });
});

describe('interceptStopList', () => {
  it('falls back to the shipped list for a profile that predates it', () => {
    const state = importJson('{"settings":{"githubUser":"octocat"}}');
    expect(state.settings?.interceptStopList).toEqual(DEFAULT_STOP_LIST);
  });

  it('treats an empty list as a real choice and normalizes the entries', () => {
    expect(importJson('{"settings":{"interceptStopList":[]}}').settings?.interceptStopList).toEqual([]);
    expect(
      importJson('{"settings":{"interceptStopList":["  NEW ","new","",42]}}').settings
        ?.interceptStopList,
    ).toEqual(['new']);
  });

  it('round trips through export', () => {
    const state = importJson(exportJson(STATE));
    expect(state.settings?.interceptStopList).toEqual(['new', 'r']);
  });
});

/**
 * The format-1 reader. `keyOverrides` was the only place a v1 file recorded a
 * rebinding, so losing it would silently un-rebind every keyword the user
 * changed — the failure they would notice last and trust least.
 */
describe('a format 1 file', () => {
  it('is accepted and its keyOverrides arrive as an edit', () => {
    const state = importJson('{"version":1,"overrides":{"keyOverrides":{"gh":["hub"]}}}');
    expect(state.overrides.edits.gh.keys).toEqual(['hub']);
    expect(mergeCommands(BUILTIN_COMMANDS, state.overrides).find((cmd) => cmd.id === 'gh')?.keys).toEqual([
      'hub',
    ]);
  });

  it('is recognized as a bare overrides snippet too', () => {
    expect(importJson('{"keyOverrides":{"gh":["hub"]}}').overrides.edits.gh.keys).toEqual(['hub']);
  });

  it('lets an explicit edit win over the legacy map', () => {
    const state = importJson(
      '{"overrides":{"keyOverrides":{"gh":["hub"]},"edits":{"gh":{"keys":["octo"],"name":"Mine"}}}}',
    );
    expect(state.overrides.edits.gh).toEqual({ keys: ['octo'], name: 'Mine' });
  });

  it('folds the legacy map alongside an edit that does not name keys', () => {
    const state = importJson(
      '{"overrides":{"keyOverrides":{"gh":["hub"]},"edits":{"gh":{"name":"Mine"}}}}',
    );
    expect(state.overrides.edits.gh).toEqual({ name: 'Mine', keys: ['hub'] });
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
  const file = JSON.stringify({
    overrides: {
      edits: {
        gh: {
          handler: 'ai',
          provider: 'chatgpt',
          builtin: true,
          id: 'evil',
          url: 'https://evil.test/',
        },
      },
    },
  });

  /** The production step between the parser and the merge: skipping it would
   *  test a path no surface actually runs. */
  const imported = (): Overrides =>
    applyImport(importJson(file), { overrides: DEFAULT_OVERRIDES, settings: DEFAULT_SETTINGS })
      .overrides;

  it('keeps only the fields an edit is allowed to name', () => {
    expect(Object.keys(imported().edits.gh)).toEqual(['url']);
  });

  it('leaves the merged command\'s handler, builtin flag and id alone', () => {
    const gh = buildKeyMap(mergeCommands(BUILTIN_COMMANDS, imported())).get('gh');
    expect(gh?.handler).toBe('github');
    expect(gh?.builtin).toBe(true);
    expect(gh?.id).toBe('gh');
    expect(gh?.provider).toBeUndefined();
    // The one field it WAS allowed to change did change.
    expect(gh?.url).toBe('https://evil.test/');
  });

  it('holds even when the edit reaches the merge unparsed', () => {
    // The storage boundary strips these fields, so the two cases above stay
    // green even if `applyEdit` spread the edit onto the command. The merge is
    // the second lock, and this is the only place that turns it: an override
    // blob handed straight to `mergeCommands` — a stored blob written by an
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

  it('takes it and every alias out of the merge', () => {
    const keys = buildKeyMap(mergeCommands(BUILTIN_COMMANDS, state.overrides));
    expect(keys.has('gh')).toBe(false);
    expect(keys.has('github')).toBe(false);
  });

  it('keeps the edit, so restoring it restores what the user had', () => {
    expect(state.overrides.edits.gh).toEqual({ name: 'Mine' });
  });

  it('survives an export round trip and stays restorable', () => {
    const round = importJson(exportJson({ overrides: state.overrides, settings: DEFAULT_SETTINGS }));
    expect(round.overrides.deleted).toEqual(['gh']);
    expect(restorableShipped(BUILTIN_COMMANDS, round.overrides).map((cmd) => cmd.name)).toEqual([
      'GitHub',
    ]);
  });
});
