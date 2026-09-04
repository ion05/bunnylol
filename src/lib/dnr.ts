/**
 * declarativeNetRequest rules that turn a search-results navigation into a
 * BunnyLol dispatch.
 *
 * The user types `gh facebook/react` in the address bar, Chrome decides it is
 * not a URL and starts navigating to google.com/search?q=gh+facebook%2Freact,
 * and a DNR redirect rule catches that main-frame request before it leaves the
 * browser and rewrites it to go.html?q=gh+facebook%2Freact. No request is ever
 * sent to the search engine.
 *
 * This file is the browser side of that line: the serialized rebuild that
 * reads stored state, registers the rules and parks the outcome. What a rule
 * IS lives in three modules underneath, two of them pure and one of them the
 * async validation step, and this file re-exports the pieces its callers
 * already import from here:
 *
 *   dnr/keywords.ts  which aliases survive the caps, and in what order
 *   dnr/rules.ts     every rule that can be registered, `buildRules` included
 *   dnr/fit.ts       Chrome's RE2 check, the resplitting, the coverage wording
 *
 * `buildRules` is pure, it never touches `chrome.*`, so the regex generation
 * is unit-testable in Node. `syncRules` registers the very same patterns, but
 * asks Chrome to validate each one first and splits the ones it rejects, which
 * is inherently async and so lives on the browser side of the line. It reaches
 * them through `planRedirects` and `fitPlan`, which are the same constructors
 * `buildRules` composes rather than a second copy of them: only tests call
 * `buildRules`, so a test driving it alone is testing `dnr/rules.ts` with the
 * fitting step removed, not what ships.
 */

import { SEARCH_ENGINES } from './commands';
import { describeCoverage, fitPlan } from './dnr/fit';
import { planRedirects } from './dnr/rules';
import { activeKeywords } from './resolve';
import { loadResolveContext } from './storage';
import { errorText } from './text';
import { DEFAULT_STOP_LIST } from './types';
import type { RuleStatus, SearchEngineId } from './types';

// The rule-construction surface `tests/dnr.test.ts` and
// `tests/self-interception.test.ts` read through this module, re-exported so
// the split costs no caller an edit.
export { buildRules, MAX_RULES } from './dnr/rules';
export { MAX_ALTERNATION_CHARS } from './dnr/keywords';

// ---------------------------------------------------- the serialized queue ----

/** The rebuild currently in flight, or `null` when nothing is running. */
let chain: Promise<RuleStatus> | null = null;

/**
 * The one follow-up rebuild shared by every caller that arrived mid-flight.
 * Non-null from the moment it is scheduled until the moment it starts.
 */
let trailing: Promise<RuleStatus> | null = null;

/**
 * Rebuilds the dynamic rule set from stored state, serialized. Never rejects: a
 * failed rebuild is reported through `RuleStatus.error` and mere partial
 * coverage through `RuleStatus.warning`, because an exception here would take
 * down the service worker and with it the omnibox.
 *
 * Serialized because rule ids are renumbered densely from the current keyword
 * count, so two rebuilds that overlap fight over one id space: the older run
 * removes the ids it read before the newer run added them, `updateDynamicRules`
 * rejects the duplicate, and `failClosed` then tears the whole dynamic table
 * down. A burst of saves, which is exactly what onboarding produces, one
 * `onStateChanged` each, is that pattern.
 *
 * One trailing slot, not a queue of N: every caller that arrives while a
 * rebuild is in flight shares a single follow-up run, so N concurrent calls
 * cost at most two rule writes. Every caller still resolves with the status of
 * a run that STARTED AFTER its own call, so nobody is handed a status that
 * predates the state they just saved.
 */
export function syncRules(): Promise<RuleStatus> {
  // `trailing` is checked FIRST and on its own: `chain` is cleared when a
  // rebuild settles, which is a microtask or two before the follow-up it
  // scheduled actually starts. A caller landing in that gap sees no rebuild in
  // flight, and if it only consulted `chain` it would open a second one
  // alongside the follow-up that is about to run: the very overlap this
  // serialization exists to prevent. A scheduled-but-unstarted follow-up still
  // starts after this call, so sharing it keeps the freshness guarantee.
  const scheduled = trailing;
  if (scheduled) return scheduled;
  if (!chain) return start();
  // `runSync` reports failure through `RuleStatus.error` rather than rejecting,
  // but a rejection must not be able to strand the queue, so the follow-up is
  // scheduled from both settlement paths.
  trailing = chain.then(startTrailing, startTrailing);
  return trailing;
}

function startTrailing(): Promise<RuleStatus> {
  trailing = null;
  return start();
}

function start(): Promise<RuleStatus> {
  const run: Promise<RuleStatus> = runSync().finally(() => {
    if (chain === run) chain = null;
  });
  chain = run;
  return run;
}

// ------------------------------------------------------------- one rebuild ----

/**
 * One rebuild of the dynamic rule set from stored state. Never throws: a failed
 * sync is reported through `RuleStatus.error` and mere partial coverage through
 * `RuleStatus.warning`, because an exception here would take down the service
 * worker and with it the omnibox.
 *
 * Reached only through `syncRules`, which serializes the rebuilds.
 */
async function runSync(): Promise<RuleStatus> {
  const extensionId = chrome.runtime.id;
  let eligible = 0;
  let suppressed = 0;

  try {
    const { commands, settings } = await loadResolveContext();
    const stopList = settings.interceptStopList ?? DEFAULT_STOP_LIST;
    const keywords = activeKeywords(commands, stopList);
    eligible = keywords.length;
    // Only interception is suppressed; every one of these aliases still
    // resolves from the `bl` omnibox and the popup.
    suppressed = activeKeywords(commands).length - eligible;

    const intercepted = new Set<SearchEngineId>(settings.interceptEngines ?? []);
    const engines = SEARCH_ENGINES.filter((engine) => intercepted.has(engine.id));
    const plan = planRedirects(keywords, engines, extensionId);
    const fitted = await fitPlan(plan, engines, keywords, extensionId);
    // Nothing was planned when the user selected no engines, so nothing was
    // dropped either: reporting `eligible` here told someone who deliberately
    // turned interception off that they had hit a quota.
    const dropped = engines.length === 0 ? 0 : eligible - fitted.covered;

    // Read the ids back rather than assuming our own numbering: a previous
    // build may have used a different sharding and left rules we must clear.
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map((rule) => rule.id),
        addRules: fitted.rules,
      });
    } catch (err) {
      return await rememberStatus(await failClosed(err, extensionId, suppressed, eligible));
    }

    return await rememberStatus({
      // Counted from the browser, not from what we asked for: the options page
      // pill must not claim rules that Chrome refused.
      registered: await countDynamicRules(),
      keywords: fitted.covered,
      suppressed,
      dropped,
      error: null,
      warning: engines.length === 0 ? null : describeCoverage(fitted, dropped),
      extensionId,
    });
  } catch (err) {
    // We never reached the replacement, so whatever the last successful sync
    // registered is still live and still intercepting. Reporting zero coverage
    // here, as this used to, describes a browser state that does not exist.
    const live = (await lastRuleStatus())?.keywords ?? 0;
    return await rememberStatus({
      registered: await countDynamicRules(),
      keywords: live,
      suppressed,
      dropped: Math.max(eligible - live, 0),
      error: errorText(err),
      warning: null,
      extensionId,
    });
  }
}

/**
 * `updateDynamicRules` is atomic, so a rejected update leaves the PREVIOUS rule
 * set live and untouched rather than leaving nothing behind.
 *
 * Those survivors are not a harmless leftover. They were built for the state
 * the user has just changed, an alias they disabled, an engine they unchecked,
 * a reload under a new extension id, and a redirect rule that outlives its
 * matching allow and escape rules is precisely the redirect loop the priority
 * tiers exist to prevent, with the options page meanwhile reporting that
 * interception is off. So the failure path tears the whole dynamic table down,
 * and when even that is refused it says what is still running instead of
 * claiming zero.
 */
async function failClosed(
  err: unknown,
  extensionId: string,
  suppressed: number,
  eligible: number,
): Promise<RuleStatus> {
  const reason = errorText(err);
  // Read before the teardown: it describes the rules that are live right now.
  const stale = await lastRuleStatus();

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: [],
    });
  } catch (removeErr) {
    const live = stale?.keywords ?? 0;
    return {
      registered: await countDynamicRules(),
      keywords: live,
      suppressed,
      dropped: Math.max(eligible - live, 0),
      error: `Rule sync failed (${reason}) and the rules from the last sync could not be removed either (${errorText(removeErr)}). Address-bar interception is still running on those older rules, so a shortcut you just changed may still go to its old destination. Reload the extension.`,
      warning: null,
      extensionId,
    };
  }

  return {
    registered: await countDynamicRules(),
    keywords: 0,
    suppressed,
    dropped: eligible,
    error: `Rule sync failed: ${reason}. Address-bar interception is off. The rules from the last sync were removed rather than left running against settings they no longer match.`,
    warning: null,
    extensionId,
  };
}

async function countDynamicRules(): Promise<number> {
  try {
    return (await chrome.declarativeNetRequest.getDynamicRules()).length;
  } catch {
    return 0;
  }
}

// --------------------------------------------------- the remembered status ----

/** Where the last `syncRules` outcome is parked for the next worker instance. */
const STATUS_KEY = 'bunnylol.ruleStatus.v1';

/**
 * The outcome of the last sync, or null when this browser session has not run
 * one. Reported by the options page instead of a freshly invented "everything
 * is fine", which is what hid partial failures before.
 */
export async function lastRuleStatus(): Promise<RuleStatus | null> {
  const area = sessionArea();
  if (area) {
    try {
      const bag = await area.get(STATUS_KEY);
      const stored = bag?.[STATUS_KEY];
      if (isRuleStatus(stored)) return stored;
    } catch {
      // Session storage unavailable (or wiped); fall back to this instance.
    }
  }
  return cachedStatus;
}

/**
 * Forgets the last sync's outcome, both copies of it.
 *
 * For the one caller that is putting the profile back to how it was installed:
 * a status left behind describes rules built from state that no longer exists,
 * and the options page would report it as the current coverage until the next
 * sync answers. The module copy has to go too, because it is what
 * `lastRuleStatus` falls back to when session storage is missing.
 */
export async function forgetRuleStatus(): Promise<void> {
  cachedStatus = null;
  const area = sessionArea();
  if (!area) return;
  try {
    await area.remove(STATUS_KEY);
  } catch {
    // A status that could not be cleared is overwritten by the sync that
    // follows it; it must not fail the reset.
  }
}

/**
 * An MV3 worker is torn down after ~30s idle, so a module-level variable alone
 * would forget the last sync almost immediately. `chrome.storage.session` is
 * per-browser-session and never hits disk, which is exactly the lifetime a rule
 * status should have; the module copy only covers builds where it is missing.
 */
let cachedStatus: RuleStatus | null = null;

async function rememberStatus(status: RuleStatus): Promise<RuleStatus> {
  cachedStatus = status;
  const area = sessionArea();
  if (area) {
    try {
      await area.set({ [STATUS_KEY]: status });
    } catch {
      // Storing the status must never fail the sync it describes.
    }
  }
  return status;
}

function sessionArea(): chrome.storage.StorageArea | null {
  try {
    return typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null;
  } catch {
    return null;
  }
}

function isRuleStatus(value: unknown): value is RuleStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<RuleStatus>;
  return (
    typeof status.registered === 'number' &&
    typeof status.keywords === 'number' &&
    // A status stored by an older build has no `dropped`, and one stored before
    // `error` was split has no `warning`; rejecting those here is what stops the
    // options page from rendering "undefined dropped" or silently losing the
    // partial-coverage message.
    typeof status.dropped === 'number' &&
    (typeof status.warning === 'string' || status.warning === null)
  );
}
