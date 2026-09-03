/**
 * The install and update branch, driven end to end.
 *
 * `background.ts` cannot be imported, it calls `chrome.omnibox` at module
 * scope, so `lib/install.ts` holds the work and this suite runs it against
 * the same `chrome` stub the rule suites use. That makes the question these
 * tests actually care about answerable: not "what did it write" but "what
 * would Chrome do with the address bar afterwards". The pick is written before
 * `syncRules`, so a fresh install that never touches the welcome tab must
 * already have Purdue out of the rules and GitHub in them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { lastRuleStatus, syncRules } from '../src/lib/dnr';
import {
  WELCOME_PATH,
  adoptNewBuiltins,
  onInstalled,
  startOver,
  writeStarterPick,
} from '../src/lib/install';
import { STARTER_CATEGORIES, effectiveCategories } from '../src/lib/onboarding';
import { shortcutId } from '../src/lib/overrides';
import { loadState } from '../src/lib/storage';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS, STORAGE_KEY } from '../src/lib/types';
import type { Command, Overrides, StoredState } from '../src/lib/types';
import { parseRoute } from '../src/options/router';
import { EXT_ID, claim, installChromeStub, redirectTo, resultsUrl } from './helpers/rules';
import type { ChromeStub } from './helpers/rules';

let stub: ChromeStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
  vi.restoreAllMocks();
});

/** By id, not by position: the engine order is a display decision. */
const GOOGLE = SEARCH_ENGINES.find((engine) => engine.id === 'google')!;

function stored(overrides: Partial<Overrides> = {}): StoredState {
  return {
    overrides: { ...DEFAULT_OVERRIDES, ...overrides },
    settings: { ...DEFAULT_SETTINGS },
  };
}

function allBuiltinIds(): string[] {
  return BUILTIN_COMMANDS.map(shortcutId);
}

function idsIn(category: string): string[] {
  return BUILTIN_COMMANDS.filter((cmd) => cmd.category === category).map(shortcutId);
}

async function fire(reason: string): Promise<void> {
  await onInstalled({ reason } as chrome.runtime.InstalledDetails);
}

/** What Chrome would do with an address-bar search for `<alias> …`. */
function addressBar(alias: string): 'allow' | 'redirect' | null {
  return claim(stub?.rules() ?? [], resultsUrl(GOOGLE, `${alias}+something`));
}

describe('a fresh install', () => {
  it('writes the starter pick once, then builds the rules from it', async () => {
    stub = installChromeStub();

    await fire('install');

    const { overrides } = await loadState();
    expect(overrides.enabledCategories).toEqual(effectiveCategories(STARTER_CATEGORIES));
    // One write for the pick. A burst of them is what collides on DNR rule ids.
    expect(stub.writes).toBe(1);

    const disabled = new Set(overrides.disabled);
    for (const id of idsIn('purdue')) expect(disabled.has(id)).toBe(true);
    for (const id of idsIn('dev')) expect(disabled.has(id)).toBe(false);
    // Nobody declines the meta pack: it is the way back to this page.
    for (const id of idsIn('meta')) expect(disabled.has(id)).toBe(false);
  });

  it('leaves an unpicked pack out of the address bar and a picked one in it', async () => {
    stub = installChromeStub();

    await fire('install');

    expect(addressBar('gh')).toBe('redirect');
    expect(addressBar('bs')).not.toBe('redirect');
  });

  it('opens the picker on the welcome route', async () => {
    stub = installChromeStub();

    await fire('install');

    expect(stub.opened).toEqual([`chrome-extension://${EXT_ID}/${WELCOME_PATH}`]);
    expect(stub.optionsPages).toBe(0);
    // Not self-referential: the path the worker opens has to be a url the
    // options page serves and a hash its router answers to as `welcome`.
    expect(WELCOME_PATH.startsWith('options.html#')).toBe(true);
    expect(parseRoute(WELCOME_PATH.slice(WELCOME_PATH.indexOf('#'))).name).toBe('welcome');
  });

  it('falls back to the options page when a tab cannot be opened', async () => {
    stub = installChromeStub({ rejectTabsCreate: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await fire('install');

    expect(stub.opened).toEqual([]);
    expect(stub.optionsPages).toBe(1);
  });

  it('does not reset or re-onboard a profile whose storage survived the uninstall', async () => {
    // Any builtin: this one stands in for a shortcut the user switched off by
    // hand, and the point is only that the reinstall leaves it exactly so.
    const switchedOff = shortcutId(BUILTIN_COMMANDS[0]);
    const kept = stored({
      enabledCategories: ['purdue'],
      seenBuiltins: allBuiltinIds(),
      disabled: [switchedOff],
    });
    stub = installChromeStub({ state: kept });

    await fire('install');

    const { overrides } = await loadState();
    expect(overrides.enabledCategories).toEqual(['purdue']);
    expect(overrides.disabled).toEqual([switchedOff]);
    expect(stub.writes).toBe(0);
    // Never shown the picker unasked: this is an existing user whose answer is
    // already on record, and `install` fires for a re-add over live storage as
    // readily as for a first run. Settings links to the picker for a re-pick.
    expect(stub.opened).toEqual([]);
    expect(stub.optionsPages).toBe(0);
  });

  it('survives a sync that rejects before it can report a status', async () => {
    stub = installChromeStub();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // `runSync` reads `chrome.runtime.id` outside its own try, so a worker
    // whose context is gone rejects the promise rather than returning a
    // status. This runs from a fire-and-forget listener, where that is an
    // unhandled rejection, and it would take the picker down with it.
    Object.defineProperty(globalThis.chrome.runtime, 'id', {
      configurable: true,
      get(): string {
        throw new Error('Extension context invalidated.');
      },
    });

    await expect(fire('install')).resolves.toBeUndefined();

    expect(stub.opened).toHaveLength(1);
  });

  it('still syncs and still opens the picker when the write fails', async () => {
    stub = installChromeStub();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const chromeStub = globalThis.chrome as unknown as {
      storage: { local: { set: (values: Record<string, unknown>) => Promise<void> } };
    };
    chromeStub.storage.local.set = async () => {
      throw new Error('QUOTA_BYTES quota exceeded');
    };

    await fire('install');

    // The rules and the picker are what make the extension usable at all, and
    // a profile whose pick could not be written has still never answered the
    // picker, so it opens, and the user redoes the pick from it.
    expect(stub.rules().length).toBeGreaterThan(0);
    expect(stub.opened).toHaveLength(1);
  });
});

describe('an update', () => {
  it('folds a builtin the profile has never seen into the pick it made', async () => {
    const newPurdue = idsIn('purdue')[0];
    const newSearch = idsIn('search')[0];
    const seen = allBuiltinIds().filter((id) => id !== newPurdue && id !== newSearch);
    stub = installChromeStub({
      state: stored({ enabledCategories: ['search'], seenBuiltins: seen }),
    });

    await fire('update');

    const { overrides } = await loadState();
    expect(overrides.disabled).toContain(newPurdue);
    expect(overrides.disabled).not.toContain(newSearch);
    expect(overrides.seenBuiltins).toHaveLength(allBuiltinIds().length);
    expect(stub.writes).toBe(1);
  });

  it('writes nothing when the registry holds nothing new', async () => {
    stub = installChromeStub({
      state: stored({ enabledCategories: ['search'], seenBuiltins: allBuiltinIds() }),
    });

    await fire('update');

    // `migrateNewBuiltins` answers by reference, and a write here would cost a
    // second rule rebuild through `onStateChanged` for no change at all.
    expect(stub.writes).toBe(0);
    expect(stub.rules().length).toBeGreaterThan(0);
  });

  it('never opens the picker at an existing user', async () => {
    stub = installChromeStub({ state: stored({ enabledCategories: ['search'] }) });

    await fire('update');

    expect(stub.opened).toEqual([]);
    expect(stub.optionsPages).toBe(0);
  });
});

describe('any other reason', () => {
  it('syncs the rules and touches nothing else', async () => {
    stub = installChromeStub({ state: stored({ enabledCategories: ['search'] }) });

    await fire('chrome_update');

    expect(stub.writes).toBe(0);
    expect(stub.opened).toEqual([]);
    expect(stub.rules().length).toBeGreaterThan(0);
  });
});

describe('starting over', () => {
  const mine: Command = {
    id: 'u:tix',
    keys: ['tix'],
    name: 'Tickets',
    description: 'Buy tickets.',
    url: 'https://example.com',
    category: 'sec-mine',
    builtin: false,
  };

  /** A profile that has been lived in: a pick, a shortcut of their own, an
   *  edit, a section, a deletion, a switched-off builtin and settings. */
  function usedProfile(): StoredState {
    const [first, second] = BUILTIN_COMMANDS;
    return {
      overrides: {
        ...DEFAULT_OVERRIDES,
        enabledCategories: ['purdue'],
        seenBuiltins: allBuiltinIds(),
        disabled: [shortcutId(first)],
        deleted: [shortcutId(second)],
        edits: { [shortcutId(first)]: { name: 'Renamed by hand' } },
        sections: [{ id: 'sec-mine', label: 'Mine' }],
        custom: [mine],
      },
      settings: { ...DEFAULT_SETTINGS, githubUser: 'octocat', googleAccount: 3 },
    };
  }

  it('leaves the profile in the state a fresh install leaves it in', async () => {
    stub = installChromeStub({ state: usedProfile() });

    await startOver();

    const { overrides, settings } = await loadState();
    expect(overrides.enabledCategories).toEqual(effectiveCategories(STARTER_CATEGORIES));
    expect(overrides.custom).toEqual([]);
    expect(overrides.edits).toEqual({});
    expect(overrides.sections).toEqual([]);
    expect(overrides.deleted).toEqual([]);
    expect(settings).toEqual(DEFAULT_SETTINGS);

    // The same projection `applyCategoryPick` makes on a real install: every
    // builtin outside the starter packs is off, and every one inside them is
    // on, including the builtin this profile had switched off by hand.
    const picked = new Set(effectiveCategories(STARTER_CATEGORIES));
    const off = new Set(overrides.disabled);
    for (const cmd of BUILTIN_COMMANDS) {
      expect(off.has(shortcutId(cmd))).toBe(!picked.has(cmd.category));
    }
    // One write, the pick, as on a fresh install: a burst is what collides on
    // DNR rule ids.
    expect(stub.writes).toBe(1);
  });

  it('clears the stale rule status before the rebuild writes a new one', async () => {
    stub = installChromeStub({ state: usedProfile() });
    // A status describing rules built from the state this is about to delete.
    await syncRules();
    expect(await lastRuleStatus()).not.toBeNull();
    stub.ops.length = 0;

    await startOver();

    // The state key goes first: `writeStarterPick` has to be answering for a
    // profile that has never onboarded, which is only true once it is gone.
    expect(stub.ops[0]).toBe(`local.remove ${STORAGE_KEY}`);
    const session = stub.ops.filter((op) => op.startsWith('session.'));
    expect(session[0]?.startsWith('session.remove')).toBe(true);
    expect(session.slice(1).every((op) => op.startsWith('session.set'))).toBe(true);
    // And the sync that follows leaves a status of its own, so the page has
    // something to report rather than "checking".
    expect(await lastRuleStatus()).not.toBeNull();
  });

  it('rebuilds the address bar around the starter pick', async () => {
    stub = installChromeStub({ state: usedProfile() });
    await syncRules();
    // What this profile had: its own keyword live, and Purdue picked.
    expect(addressBar('tix')).toBe('redirect');
    expect(addressBar('bs')).toBe('redirect');

    await startOver();

    expect(addressBar('tix')).not.toBe('redirect');
    expect(addressBar('bs')).not.toBe('redirect');
    expect(addressBar('gh')).toBe('redirect');
    expect(redirectTo(stub.rules(), resultsUrl(GOOGLE, 'gh+facebook%2Freact'))).toBe(
      `chrome-extension://${EXT_ID}/go.html?q=gh+facebook%2Freact`,
    );
  });

  it('opens nothing: the page it runs from navigates itself', async () => {
    stub = installChromeStub({ state: usedProfile() });

    await startOver();

    expect(stub.opened).toEqual([]);
    expect(stub.optionsPages).toBe(0);
  });
});

describe('the pieces on their own', () => {
  it('writeStarterPick answers whether it wrote', async () => {
    stub = installChromeStub();
    expect(await writeStarterPick()).toBe(true);
    expect(await writeStarterPick()).toBe(false);
    expect(stub.writes).toBe(1);
  });

  it('adoptNewBuiltins answers whether it wrote', async () => {
    stub = installChromeStub({
      state: stored({ enabledCategories: ['search'], seenBuiltins: [] }),
    });
    expect(await adoptNewBuiltins()).toBe(true);
    expect(await adoptNewBuiltins()).toBe(false);
    expect(stub.writes).toBe(1);
  });
});
