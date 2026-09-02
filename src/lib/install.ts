/**
 * What the extension does the first time it runs in a profile, and what it does
 * to a profile that already has one.
 *
 * This lives outside `background.ts` because the service worker may only
 * register listeners synchronously at module scope, which makes the file
 * itself unimportable in a test: `chrome.omnibox.setDefaultSuggestion` runs
 * the moment it is loaded. The listener there is a one-liner that hands the
 * event straight here, so the install path can be driven end to end against
 * the storage and rule stubs instead of being reasoned about.
 */

import { BUILTIN_COMMANDS } from './commands';
import { syncRules } from './dnr';
import {
  STARTER_CATEGORIES,
  applyCategoryPick,
  hasOnboarded,
  migrateNewBuiltins,
} from './onboarding';
import { loadState, saveOverrides } from './storage';

/**
 * The picker, as a page the worker can open. `chrome.runtime.openOptionsPage()`
 * cannot carry a hash, it opens whatever `options_page` names, so the tab is
 * opened by URL and that call is only the fallback.
 */
export const WELCOME_PATH = 'options.html#welcome';

/**
 * The install/update branch, in the order that makes it correct.
 *
 * The pick is written BEFORE the rules are built, so the very first rule set
 * Chrome holds already matches it. That is what makes closing the welcome tab
 * without answering a real answer: the starter set is already live rather than
 * waiting on a click the user never makes.
 *
 * A setup failure must not cost the profile its redirect rules, so the write is
 * the only thing inside the try: every reason still syncs afterwards. The
 * extension id changes on every load-unpacked, which would otherwise leave the
 * redirects pointing at a dead origin: that is why this listener exists at all.
 *
 * The picker opens only for a profile that has never answered it. `install`
 * also fires when the extension is removed and added back over storage that
 * survived, and an existing user is never shown the picker unasked: Settings
 * has a link to it for when they want it.
 */
export async function onInstalled(details: chrome.runtime.InstalledDetails): Promise<void> {
  let unonboarded = false;
  try {
    if (details.reason === 'install') unonboarded = await writeStarterPick();
    else if (details.reason === 'update') await adoptNewBuiltins();
  } catch (err) {
    console.error('[bunnylol] install-time setup failed', err);
    // A pick that could not be written leaves the profile un-onboarded, which
    // is exactly who the picker is for: it is where the user redoes it.
    unonboarded = details.reason === 'install';
  }

  // `syncRules` can reject before its own try, it reads `chrome.runtime.id`
  // first, and this runs from a fire-and-forget listener, where a rejection
  // is an unhandled one and skips the picker below.
  await syncRules().catch((err) => console.error('[bunnylol] install-time sync failed', err));

  if (details.reason === 'install' && unonboarded) await openWelcome();
}

/**
 * Turns the starter packs on for a profile that has never answered the picker.
 *
 * Guarded by `hasOnboarded`, because `reason === 'install'` also fires when the
 * extension is removed and added back over storage that survived: resetting a
 * configured profile to the starter set is the one thing this must never do.
 * Answers whether it wrote, so the caller (and the tests) can tell the two
 * cases apart.
 */
export async function writeStarterPick(): Promise<boolean> {
  const state = await loadState();
  if (hasOnboarded(state.overrides)) return false;
  await saveOverrides(applyCategoryPick(BUILTIN_COMMANDS, STARTER_CATEGORIES, state.overrides));
  return true;
}

/**
 * Folds the builtins added by this update into the pick the user already made,
 * rather than switching them all on regardless of it.
 *
 * `migrateNewBuiltins` returns its input by reference when there is nothing
 * new, which is the common case for an update: the identity check keeps the
 * ordinary version bump from writing storage and so from firing the
 * `onStateChanged` re-sync on top of the one below.
 */
export async function adoptNewBuiltins(): Promise<boolean> {
  const state = await loadState();
  const next = migrateNewBuiltins(BUILTIN_COMMANDS, state.overrides);
  if (next === state.overrides) return false;
  await saveOverrides(next);
  return true;
}

/** Opens the picker, and never rejects: the extension is installed and working
 *  either way, so a tab that could not be opened is worth a log and nothing
 *  more. */
async function openWelcome(): Promise<void> {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PATH) });
  } catch (err) {
    console.error('[bunnylol] could not open the welcome tab', err);
    try {
      await chrome.runtime.openOptionsPage();
    } catch (fallbackErr) {
      console.error('[bunnylol] could not open the options page', fallbackErr);
    }
  }
}
