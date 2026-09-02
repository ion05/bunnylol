/**
 * The override layer under adversarial input.
 *
 * An import file is untrusted: it is JSON somebody can hand-edit, and the
 * difference between renaming GitHub and pointing the `github` handler at your
 * own host is one field. Every case here drives the PRODUCTION path end to end —
 * `importJson` → `applyImport` → the storage boundary (through `exportJson`) →
 * `mergeCommands` → `resolve` — rather than calling one helper, so a hole in any
 * single layer fails here even if the layer next to it would have caught it.
 *
 * The one DNR case runs against the real `syncRules` for the reason AGENTS.md
 * gives: a routing guarantee that has only been read is not a guarantee.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { syncRules } from '../src/lib/dnr';
import { applyCategoryPick } from '../src/lib/onboarding';
import { restorableShipped, shortcutId } from '../src/lib/overrides';
import { buildKeyMap, mergeCommands, resolve } from '../src/lib/resolve';
import { applyImport, exportJson, importJson } from '../src/lib/storage';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS, FALLBACK_SECTION } from '../src/lib/types';
import type { Command, Overrides, Settings, ShortcutEdit, StoredState } from '../src/lib/types';
import { claim, installChromeStub, resultsUrl } from './helpers/rules';

const CLEAN: StoredState = { overrides: DEFAULT_OVERRIDES, settings: DEFAULT_SETTINGS };

const GOOGLE = SEARCH_ENGINES[0];

interface Landed {
  overrides: Overrides;
  settings: Settings;
  commands: Command[];
  /** The command a keyword resolves to after the whole pipeline, or undefined. */
  by(keyword: string): Command | undefined;
  go(query: string): string;
}

/**
 * The file, all the way through to what the user's browser would do with it.
 * `exportJson` is how the storage boundary is reached from a test: it is
 * `normalizeState` with a `JSON.stringify` on the end, which is exactly what a
 * save writes.
 */
function land(file: string, current: StoredState = CLEAN): Landed {
  const saved = JSON.parse(exportJson(applyImport(importJson(file), current))) as StoredState;
  const commands = mergeCommands(BUILTIN_COMMANDS, saved.overrides);
  const keyMap = buildKeyMap(commands);
  return {
    overrides: saved.overrides,
    settings: saved.settings,
    commands,
    by: (keyword) => keyMap.get(keyword),
    go: (query) => resolve(query, commands, saved.settings).url,
  };
}

function file(overrides: unknown): string {
  return JSON.stringify({ overrides });
}

describe('an edit cannot inject a handler', () => {
  it('leaves the shipped handler on the command and the slot guard intact', () => {
    const landed = land(
      file({
        edits: {
          usps: { handler: 'meta', name: 'Parcels', searchUrl: 'https://evil.test/{q}' },
        },
      }),
    );
    const usps = landed.by('usps') as Command;
    expect(usps.handler).toBe('tracking');
    expect(usps.name).toBe('Parcels');
    // `handler` is not a field the edit layer carries, so it is not even stored.
    expect(landed.overrides.edits.usps).toEqual({
      name: 'Parcels',
      searchUrl: 'https://evil.test/{q}',
    });
    // Invariant 7 still holds under an edit: free text does not reach a slot.
    // The repointed searchUrl IS honoured for something tracking-shaped, which
    // is the user's own edit doing what they asked.
    expect(landed.go('usps near me open now')).toContain('google.com/search');
    expect(landed.go('usps 9400111899223197428490')).toBe(
      'https://evil.test/9400111899223197428490',
    );
  });
});

describe('an edit cannot inject a provider', () => {
  it('keeps the AI command pointed at the provider it ships with', () => {
    const landed = land(file({ edits: { c: { provider: 'chatgpt', name: 'Assistant' } } }));
    expect((landed.by('c') as Command).provider).toBe('claude');
    expect(landed.overrides.edits.c).toEqual({ name: 'Assistant' });
    expect(landed.go('c hi')).toContain('claude.ai');
    expect(landed.go('c hi')).not.toContain('chatgpt');
  });
});

describe('nothing can claim builtin', () => {
  it('imports a custom command as the user\'s own however the file labels it', () => {
    const landed = land(
      file({
        custom: [
          {
            keys: ['mine'],
            name: 'Mine',
            url: 'https://mine.example/',
            builtin: true,
            category: 'dev',
          },
        ],
        edits: { gh: { builtin: false, name: 'Hub' } },
      }),
    );
    expect(landed.overrides.custom[0].builtin).toBe(false);
    expect((landed.by('mine') as Command).builtin).toBe(false);
    expect((landed.by('gh') as Command).builtin).toBe(true);
    expect(landed.overrides.edits.gh).toEqual({ name: 'Hub' });
  });
});

describe('nothing can re-key a record', () => {
  it('refuses a custom command that claims a shipped id', () => {
    expect(() =>
      importJson(file({ custom: [{ keys: ['mine'], url: 'https://mine.example/', id: 'gh' }] })),
    ).toThrow(/reserved for shipped shortcuts/i);
  });

  it('re-mints the claim on the lenient path and leaves the shipped shortcut alone', () => {
    // The stored blob never throws (a navigation depends on it), so the claim
    // is minted over instead — and `gh` keeps its own identity either way.
    const stored = JSON.parse(
      exportJson({
        overrides: {
          ...DEFAULT_OVERRIDES,
          custom: [
            {
              id: 'gh',
              keys: ['mine'],
              name: 'Mine',
              description: '',
              url: 'https://mine.example/',
              category: 'dev',
              builtin: false,
            },
          ],
        },
        settings: DEFAULT_SETTINGS,
      }),
    ) as StoredState;
    expect(stored.overrides.custom[0].id).toBe('u:mine');
    const commands = mergeCommands(BUILTIN_COMMANDS, stored.overrides);
    expect(commands.filter((cmd) => shortcutId(cmd) === 'gh').length).toBe(1);
    expect(buildKeyMap(commands).get('gh')?.url).toBe('https://github.com/');
  });

  it('an edit that names another shortcut changes only the record it is filed under', () => {
    const landed = land(file({ edits: { gh: { id: 'npm', name: 'X' } } }));
    expect((landed.by('gh') as Command).name).toBe('X');
    expect((landed.by('npm') as Command).name).toBe('npm');
    expect(Object.keys(landed.overrides.edits)).toEqual(['gh']);
  });
});

describe('an edits map that never went through the parser', () => {
  it('still cannot change behaviour or identity', () => {
    // The storage boundary strips these fields, so every case above is really
    // testing the boundary. This one hands `mergeCommands` the object the
    // parser would have rejected — the shape a future writer into `edits`
    // could produce — so `applyEdit`'s field-by-field copy is under test on its
    // own (invariant 16).
    const hostile = {
      handler: 'meta',
      provider: 'chatgpt',
      builtin: false,
      id: 'npm',
      name: 'Assistant',
    } as unknown as ShortcutEdit;
    const commands = mergeCommands(BUILTIN_COMMANDS, {
      ...DEFAULT_OVERRIDES,
      edits: { c: hostile },
    });
    const claude = buildKeyMap(commands).get('c') as Command;
    expect(claude.name).toBe('Assistant');
    expect(claude.handler).toBe('ai');
    expect(claude.provider).toBe('claude');
    expect(claude.builtin).toBe(true);
    expect(claude.id).toBe('c');
    expect(resolve('c hi', commands, DEFAULT_SETTINGS).url).toContain('claude.ai');
  });
});

describe('an edited url that BunnyLol will not open is inherited, not applied', () => {
  it.each([
    ['blank', '   '],
    ['prose', 'not a url'],
    ['a javascript: url', 'javascript:alert(1)'],
    ['a data: url', 'data:text/html,<script>alert(1)</script>'],
  ])('%s', (_label, url) => {
    // The strict path refuses the file outright for the two that are not
    // URL-shaped at all; the blank one is "inherit" and imports cleanly.
    const blob = JSON.parse(
      exportJson({
        overrides: { ...DEFAULT_OVERRIDES, edits: { gh: { url, name: 'Mine' } } },
        settings: DEFAULT_SETTINGS,
      }),
    ) as StoredState;
    const commands = mergeCommands(BUILTIN_COMMANDS, blob.overrides);
    const gh = buildKeyMap(commands).get('gh') as Command;
    expect(gh.name).toBe('Mine');
    expect(gh.url).toBe('https://github.com/');
    expect(resolve('gh', commands, DEFAULT_SETTINGS).url).toMatch(/^https:\/\/github\.com\//);
  });

  it('is refused by name on the import path', () => {
    expect(() => importJson(file({ edits: { gh: { url: 'javascript:alert(1)' } } }))).toThrow(
      /"edits\.gh\.url"/,
    );
    expect(() =>
      importJson(file({ custom: [{ keys: ['x'], url: 'javascript:alert(1)' }] })),
    ).toThrow(/BunnyLol will not open/i);
  });
});

describe('an edited searchUrl that lost its {q} degrades instead of breaking', () => {
  it('sends the words to the command\'s own site: search', () => {
    const landed = land(file({ edits: { zoom: { searchUrl: 'https://zoom.us/j/' } } }));
    // The slot handler will not fill a template with no slot in it, so the
    // meeting id degrades exactly as an unparseable one does — a `site:` search
    // of zoom.us — rather than being appended to the truncated url. It carries
    // the passthrough marker, because that degrade lands on an engine we
    // intercept (invariant 1) and an edit must not cost that.
    expect(landed.go('zoom 1234567890')).toBe(
      'https://www.google.com/search?q=site%3Azoom.us+1234567890&blpass=1',
    );
    expect(landed.go('zoom')).toBe('https://zoom.us/');
  });
});

describe('an unknown category', () => {
  it('degrades on the import path exactly as it does on the stored one', () => {
    // Not refused: an import is somebody's backup, and the file that names a
    // group it does not declare is most often a v1.0.0 export filed under a
    // category this build stopped shipping. Refusing it makes the backup
    // unimportable and asks the user to hand-edit JSON they did not write.
    const landed = land(
      file({
        edits: { gh: { category: 'ghost', name: 'Mine' } },
        custom: [{ keys: ['x'], url: 'https://x.example/', category: 'ghost' }],
      }),
    );
    expect(landed.overrides.edits.gh).toEqual({ name: 'Mine' });
    expect((landed.by('gh') as Command).category).toBe('dev');
    expect((landed.by('x') as Command).category).toBe(FALLBACK_SECTION);
  });

  it('still imports a v1 export whose custom command is filed under media', () => {
    // `media` was a shipped category until v1.1.0. The shortcut lands in My
    // shortcuts, which is a group the user can see and move it out of.
    const landed = land(
      JSON.stringify({
        version: 1,
        overrides: {
          custom: [{ keys: ['yt'], name: 'YouTube', url: 'https://youtube.com/', category: 'media' }],
        },
      }),
    );
    expect((landed.by('yt') as Command).category).toBe(FALLBACK_SECTION);
    expect(landed.go('yt')).toBe('https://youtube.com/');
  });

  it('refuses only a category that is not a string, naming the shortcut', () => {
    expect(() => importJson(file({ edits: { gh: { category: 7 } } }))).toThrow(
      /"edits\.gh\.category" must be a string/,
    );
    expect(() =>
      importJson(file({ custom: [{ keys: ['x'], url: 'https://x.example/', category: ['dev'] }] })),
    ).toThrow(/The "category" of shortcut "x" must be a string/);
  });

  it('is accepted when the same file declares the section', () => {
    const landed = land(
      file({
        sections: [{ id: 'sec-work', label: 'Work' }],
        edits: { gh: { category: 'sec-work' } },
        custom: [{ keys: ['x'], url: 'https://x.example/', category: 'sec-work' }],
      }),
    );
    expect((landed.by('gh') as Command).category).toBe('sec-work');
    expect((landed.by('x') as Command).category).toBe('sec-work');
  });

  it('is dropped from an edit and falls back for a shortcut on the STORED path', () => {
    // Asymmetric on purpose: a shipped command has a category of its own to
    // fall back to, so relocating it to "My shortcuts" would move a shortcut
    // the user never touched. A custom command has nowhere else to go.
    const blob = JSON.parse(
      exportJson({
        overrides: {
          ...DEFAULT_OVERRIDES,
          edits: { gh: { category: 'ghost', name: 'Mine' } },
          custom: [
            {
              keys: ['x'],
              name: 'X',
              description: '',
              url: 'https://x.example/',
              category: 'ghost',
              builtin: false,
            },
          ],
        },
        settings: DEFAULT_SETTINGS,
      }),
    ) as StoredState;
    expect(blob.overrides.edits.gh).toEqual({ name: 'Mine' });
    expect(blob.overrides.custom[0].category).toBe('custom');
    const keyMap = buildKeyMap(mergeCommands(BUILTIN_COMMANDS, blob.overrides));
    expect(keyMap.get('gh')?.category).toBe('dev');
  });
});

describe('a deleted shipped shortcut', () => {
  it('stays deleted across a save round trip and is restorable', () => {
    const landed = land(file({ deleted: ['gh'] }));
    expect(landed.by('gh')).toBeUndefined();
    expect(landed.go('gh facebook/react')).toContain('google.com/search');
    expect(restorableShipped(BUILTIN_COMMANDS, landed.overrides).map(shortcutId)).toEqual(['gh']);

    const again = land(exportJson({ overrides: landed.overrides, settings: landed.settings }));
    expect(again.overrides.deleted).toEqual(['gh']);
    expect(again.by('gh')).toBeUndefined();
  });

  it('keeps its edit, so restoring does not also discard the rename', () => {
    const landed = land(file({ deleted: ['gh'], edits: { gh: { name: 'Hub' } } }));
    expect(landed.overrides.edits.gh).toEqual({ name: 'Hub' });
    const restored = mergeCommands(BUILTIN_COMMANDS, { ...landed.overrides, deleted: [] });
    expect(buildKeyMap(restored).get('gh')?.name).toBe('Hub');
  });
});

describe('an onboarding pick reaches the live DNR rules', () => {
  it('drops the aliases of an unpicked pack and keeps the picked ones', async () => {
    const stub = installChromeStub({
      state: {
        overrides: applyCategoryPick(BUILTIN_COMMANDS, ['dev'], DEFAULT_OVERRIDES),
        settings: DEFAULT_SETTINGS,
      },
    });
    try {
      await syncRules();
      const rules = stub.rules();
      // `bs` is a purdue command and was not picked: the address bar must hand
      // that query to Google rather than to a shortcut the user does not have.
      expect(claim(rules, resultsUrl(GOOGLE, 'bs+cs251'))).toBeNull();
      expect(claim(rules, resultsUrl(GOOGLE, 'gh+facebook%2Freact'))).toBe('redirect');
    } finally {
      stub.restore();
    }
  });
});
