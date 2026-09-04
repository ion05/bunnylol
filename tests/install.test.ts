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
import { at } from './helpers/at';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { WELCOME_PATH, onInstalled, startOver } from '../src/lib/install';
import { STARTER_CATEGORIES, effectiveCategories } from '../src/lib/onboarding';
import { shortcutId } from '../src/lib/overrides';
import { loadState } from '../src/lib/storage';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS } from '../src/lib/types';
import type { Command, Overrides, StoredState } from '../src/lib/types';
import { parseRoute } from '../src/options/router';
import { EXT_ID, claim, installChromeStub, resultsUrl } from './helpers/rules';
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

  it('does not reset or re-onboard a profile whose storage survived the uninstall', async () => {
    // Any builtin: this one stands in for a shortcut the user switched off by
    // hand, and the point is only that the reinstall leaves it exactly so.
    const switchedOff = shortcutId(at(BUILTIN_COMMANDS, 0));
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
    const first = at(BUILTIN_COMMANDS, 0);
    const second = at(BUILTIN_COMMANDS, 1);
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
});
