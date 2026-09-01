import { describe, expect, it } from 'vitest';
import { applyImport, exportJson, importJson } from '../src/lib/storage';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS, DEFAULT_STOP_LIST } from '../src/lib/types';
import type { StoredState } from '../src/lib/types';

const STATE: StoredState = {
  overrides: {
    disabled: ['gh', 'npm'],
    keyOverrides: { lh: ['local', 'l'] },
    custom: [
      {
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
    expect(parsed.version).toBe(1);
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
    expect(state.overrides.keyOverrides).toEqual({ lh: ['l'] });
    expect(state.overrides.custom[0].keys).toEqual(['tix']);
  });

  it('accepts a settings-only file', () => {
    const state = importJson('{"settings":{"githubUser":"octocat"}}');
    expect(state.settings?.githubUser).toBe('octocat');
    expect(state.settings?.defaultEngine).toBe(DEFAULT_SETTINGS.defaultEngine);
    expect(state.overrides).toEqual(DEFAULT_OVERRIDES);
  });

  it('accepts the current format version', () => {
    expect(() => importJson('{"version":1,"overrides":{},"settings":{}}')).not.toThrow();
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
    expect(state.overrides.keyOverrides).toEqual({ lh: ['l'] });
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
      keyOverrides: { lh: ['local', 'foo bar'], 'bad key': ['x'] },
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

  it('drops what it cannot use instead of throwing', () => {
    expect(recovered.overrides.disabled).toEqual(['gh']);
    expect(recovered.overrides.keyOverrides).toEqual({ lh: ['local'] });
    expect(recovered.overrides.custom.map((cmd: { keys: string[] }) => cmd.keys[0])).toEqual(['ok']);
    expect(recovered.overrides.custom[0].searchUrl).toBeUndefined();
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
