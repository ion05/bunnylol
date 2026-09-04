/**
 * Fitting a plan to what Chrome will actually accept.
 *
 * Chrome compiles each `regexFilter` under an RE2 memory budget and reports a
 * pattern that busts it as unsupported, so the only way to know a shard fits
 * is to ask. This is the async half of rule construction, and the reason
 * `syncRules` cannot be a pure function.
 *
 * It builds nothing of its own: every rule here comes from `./rules`, the same
 * functions `buildRules` composes. That is what makes the rules a `buildRules`
 * test inspects and the rules that ship the same rules, with this file adding
 * only the validation, the resplitting and the coverage wording on top.
 */

import { buildAllowRules, buildEscapeRules, MAX_RULES, redirectRule } from './rules';
import type { PlannedRule } from './rules';
import { dedupeKeywords } from './keywords';
import { PASSTHROUGH_PARAM } from '../types';
import type { SearchEngine, SearchEngineId } from '../types';

// ------------------------------------------------------------------ limits ----

/**
 * How many times an unsupported shard may be halved before we conclude the
 * keyword itself is the problem. 2^6 pieces is past the point where a shard
 * holds more than one keyword.
 */
const MAX_SPLIT_DEPTH = 6;

// ----------------------------------------------------------------- fitting ----

export interface FittedPlan {
  rules: chrome.declarativeNetRequest.Rule[];
  /** Aliases intercepted on EVERY selected engine: the number worth showing a user. */
  covered: number;
  /** Aliases Chrome refused to compile a pattern for, even on their own. */
  rejected: string[];
  /** Labels of engines left uninterceptable because Chrome refused their allow rule. */
  unguarded: string[];
}

/**
 * Turns a plan into the rule set we actually register: every regex validated by
 * Chrome first, oversized shards halved instead of dropped, and the whole thing
 * held under `MAX_RULES`.
 *
 * `updateDynamicRules` is all-or-nothing, so shipping one unsupported pattern
 * would leave the user with zero interception: indistinguishable from a broken
 * extension.
 */
export async function fitPlan(
  plan: PlannedRule[],
  engines: SearchEngine[],
  keywords: string[],
  extensionId: string,
): Promise<FittedPlan> {
  if (plan.length === 0) return { rules: [], covered: 0, rejected: [], unguarded: [] };

  // An engine's allow rule is a PRECONDITION for its redirect rules, not an
  // independent nicety. A redirect pattern still matches BunnyLol's own marked
  // searches, `blpass` sits past the end of the captured `q` value, where the
  // pattern swallows it as a trailing parameter, so the only thing keeping
  // `gmeet standup` out of an infinite go.html loop (its degrade puts its own
  // keyword back into the query), and `\gh foo` out of the command it escapes,
  // is the higher-priority allow rule winning first.
  // Registering redirects for an engine whose allow rule Chrome refused is
  // therefore worse than not intercepting that engine at all.
  //
  // The escape rule is a precondition for the same reason. Without it a typed
  // `\gh foo` is not intercepted at all, so the backslash reaches the engine as
  // a search term and the user's only escape hatch silently stops working,
  // and, unlike a missing keyword rule, they get no search either.
  const fixed: chrome.declarativeNetRequest.Rule[] = [];
  const guarded = new Set<SearchEngineId>();
  const allowPlan = buildAllowRules(engines);
  const escapePlan = buildEscapeRules(engines, extensionId);
  // Walked over `engines` rather than over one of the plans, because the engine
  // is what gets guarded and both plans are keyed by its index.
  for (const [index, engine] of engines.entries()) {
    const allowRule = allowPlan[index];
    const escapeRule = escapePlan[index];
    // Both builders map over `engines`, so an index of `engines` names a rule in
    // each. Except that `buildEscapeRules` answers `[]` for an empty extension
    // id, which `planRedirects` also answers `[]` to, so the early return above
    // has already taken that call. A missing rule is treated as a refused one
    // for the reason the comment above gives: no escape rule, no redirects.
    if (!allowRule || !escapeRule) continue;
    if (!(await isSupported(allowRule)) || !(await isSupported(escapeRule))) continue;
    fixed.push(allowRule, escapeRule);
    guarded.add(engine.id);
  }
  const unguarded = engines.filter((engine) => !guarded.has(engine.id));

  const budget = MAX_RULES - fixed.length;
  const redirects: chrome.declarativeNetRequest.Rule[] = [];
  const rejected = new Set<string>();
  const coveredPerEngine = new Map<SearchEngineId, Set<string>>();

  for (const planned of plan) {
    if (redirects.length >= budget) break;
    if (!guarded.has(planned.engine.id)) continue;
    const { pieces, rejected: refused } = await splitUntilSupported(planned, extensionId, 0);
    for (const keyword of refused) rejected.add(keyword);
    for (const piece of pieces) {
      // Out of budget: the piece is dropped, and its keywords stay uncovered
      // rather than being counted as intercepted.
      if (redirects.length >= budget) break;
      // Ids are provisional until here, because splitting invents rules the
      // shard numbering never allotted an id to.
      redirects.push({ ...piece.rule, id: redirects.length + 1 });
      const covered = coveredPerEngine.get(piece.engine.id) ?? new Set<string>();
      coveredPerEngine.set(piece.engine.id, covered);
      for (const keyword of piece.keywords) covered.add(keyword);
    }
  }

  const sets = engines.map((engine) => coveredPerEngine.get(engine.id) ?? new Set<string>());
  const covered = dedupeKeywords(keywords).filter((keyword) =>
    sets.every((set) => set.has(keyword)),
  ).length;

  return {
    rules: [...fixed, ...redirects],
    covered,
    rejected: [...rejected],
    unguarded: unguarded.map((engine) => engine.label),
  };
}

/**
 * Chrome's RE2 budget is on the compiled program, so the only way to know a
 * shard fits is to ask. A rejected shard is halved and each half re-checked:
 * dropping the whole shard would cost every keyword in it for one pattern that
 * was merely too wide.
 */
async function splitUntilSupported(
  planned: PlannedRule,
  extensionId: string,
  depth: number,
): Promise<{ pieces: PlannedRule[]; rejected: string[] }> {
  if (await isSupported(planned.rule)) return { pieces: [planned], rejected: [] };
  if (planned.keywords.length < 2 || depth >= MAX_SPLIT_DEPTH) {
    return { pieces: [], rejected: planned.keywords };
  }

  const middle = Math.ceil(planned.keywords.length / 2);
  const pieces: PlannedRule[] = [];
  const rejected: string[] = [];
  for (const half of [planned.keywords.slice(0, middle), planned.keywords.slice(middle)]) {
    const outcome = await splitUntilSupported(
      {
        engine: planned.engine,
        keywords: half,
        rule: redirectRule(planned.engine, half, planned.rule.id, extensionId),
      },
      extensionId,
      depth + 1,
    );
    pieces.push(...outcome.pieces);
    rejected.push(...outcome.rejected);
  }
  return { pieces, rejected };
}

async function isSupported(rule: chrome.declarativeNetRequest.Rule): Promise<boolean> {
  const regex = rule.condition.regexFilter;
  if (!regex) return false;
  try {
    const check = await chrome.declarativeNetRequest.isRegexSupported({
      regex,
      isCaseSensitive: false,
      // Only the redirect rules feed a `\\1` substitution; demanding a capture
      // group from the allow rules would reject every one of them.
      requireCapturing: rule.action.redirect?.regexSubstitution != null,
    });
    return check.isSupported === true;
  } catch {
    // The validator itself is unavailable (older Chrome, a stubbed test
    // environment); let `updateDynamicRules` be the judge instead of dropping
    // every rule we have.
    return true;
  }
}

// ------------------------------------------- what the options page is told ----

export function describeCoverage(fitted: FittedPlan, dropped: number): string | null {
  if (fitted.unguarded.length > 0) {
    // Failing closed: the alternative is an interception loop the user cannot
    // escape without closing the tab.
    return `Interception is off for ${fitted.unguarded.join(', ')}: Chrome would not accept the ${PASSTHROUGH_PARAM} allow rule or the force-search escape rule, and redirect rules without both of those send BunnyLol's own searches back into the dispatch page and leave you no way to force an ordinary search.`;
  }
  const rejected = fitted.rejected;
  if (rejected.length > 0) {
    const shown = rejected.slice(0, 5).join(', ');
    const more = rejected.length > 5 ? `, +${rejected.length - 5} more` : '';
    return `${dropped} keyword(s) are not intercepted: Chrome rejected the pattern for ${shown}${more}.`;
  }
  if (dropped > 0) return `${dropped} keyword(s) are not intercepted: the rule budget is full.`;
  return null;
}
