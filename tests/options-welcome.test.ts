/**
 * `src/options/model/welcome.ts` is what the first-run picker decides, pulled
 * out of the view so the decisions can be checked without a DOM.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`, which is only true if it touches neither `document`
 * nor `chrome.*` at module scope.
 *
 * The two questions here are the two the page answers: which boxes open ticked,
 * and what the confirming button writes. The second is asserted against
 * `applyCategoryPick` itself, because a picker that renders the ticks and then
 * writes something else is the failure mode with no visible symptom.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import {
  HIDDEN_CATEGORIES,
  OPTIONAL_CATEGORIES,
  STARTER_CATEGORIES,
  applyCategoryPick,
  categoryPicks,
  effectiveCategories,
} from '../src/lib/onboarding';
import { shortcutId } from '../src/lib/overrides';
import { CATEGORY_LABELS, DEFAULT_OVERRIDES, DEFAULT_SETTINGS } from '../src/lib/types';
import type { Overrides, StoredState } from '../src/lib/types';
import { initialPicks, pickToState } from '../src/options/model/welcome';

function overridesWith(extra: Partial<Overrides> = {}): Overrides {
  return { ...DEFAULT_OVERRIDES, ...extra };
}

function stateWith(extra: Partial<Overrides> = {}): StoredState {
  return { overrides: overridesWith(extra), settings: { ...DEFAULT_SETTINGS } };
}

/** What a real pick looks like in storage: `applyCategoryPick` normalizes it
 *  through `effectiveCategories`, so `meta` rides along in every stored answer. */
function stored(picked: string[]): string[] {
  return effectiveCategories(picked);
}

function idsIn(category: string): string[] {
  return BUILTIN_COMMANDS.filter((cmd) => cmd.category === category).map(shortcutId);
}

/** Every shipped category id, hidden ones included. */
const ALL_CATEGORY_IDS = Object.keys(CATEGORY_LABELS);

describe('which boxes open ticked', () => {
  it('shows the starter set on a profile that never answered', () => {
    expect([...initialPicks(overridesWith())]).toEqual([...STARTER_CATEGORIES]);
  });

  it('shows the answer on record on a revisit, and nothing else', () => {
    const picks = initialPicks(overridesWith({ enabledCategories: stored(['search', 'social']) }));

    expect([...picks].sort()).toEqual(['search', 'social']);
    // The optional pack stays unticked unless the user ticked it: a revisit
    // that quietly re-offers Purdue is how an existing user acquires a pack
    // they declined.
    for (const optional of OPTIONAL_CATEGORIES) expect(picks.has(optional)).toBe(false);
  });

  it('ticks the optional pack when the user picked it', () => {
    const picks = initialPicks(overridesWith({ enabledCategories: stored(['purdue']) }));

    expect([...picks]).toEqual(['purdue']);
  });

  it('ticks nothing when the user turned every pack off', () => {
    // Unticking everything writes `[]`, which `effectiveCategories` records as
    // the always-on pack alone, not as "never answered".
    expect([...initialPicks(overridesWith({ enabledCategories: stored([]) }))]).toEqual([]);
  });

  it('never ticks a pack the picker does not show', () => {
    const shown = new Set(categoryPicks(BUILTIN_COMMANDS).map((row) => row.id));
    const picks = initialPicks(overridesWith({ enabledCategories: stored(ALL_CATEGORY_IDS) }));
    const firstRun = initialPicks(overridesWith());

    for (const hidden of HIDDEN_CATEGORIES) {
      expect(picks.has(hidden)).toBe(false);
      // And the same on a first run, where the source is the starter list.
      expect(firstRun.has(hidden)).toBe(false);
    }
    for (const id of picks) expect(shown.has(id)).toBe(true);
  });
});

describe('what Continue writes', () => {
  it('is exactly the ticks, projected by applyCategoryPick', () => {
    const before = stateWith({ enabledCategories: stored(STARTER_CATEGORIES) });
    const picked = new Set(['search', 'purdue']);

    const next = pickToState(picked, before);

    expect(next.overrides).toEqual(
      applyCategoryPick(BUILTIN_COMMANDS, [...picked], before.overrides),
    );
    expect(next.settings).toBe(before.settings);
    // Read through to the effect, not just the recorded answer: the ticks are
    // what decides which shortcuts are live, so a write that ignored them
    // would still look right in `enabledCategories`.
    const disabled = new Set(next.overrides.disabled);
    for (const id of idsIn('purdue')) expect(disabled.has(id)).toBe(false);
    for (const id of idsIn('search')) expect(disabled.has(id)).toBe(false);
    for (const id of idsIn('dev')) expect(disabled.has(id)).toBe(true);
    for (const id of idsIn('ai')) expect(disabled.has(id)).toBe(true);
  });

  it('turns every shipped pack off when nothing is ticked', () => {
    const before = stateWith({ enabledCategories: stored(STARTER_CATEGORIES) });

    const next = pickToState(new Set<string>(), before);

    expect(next.overrides.enabledCategories).toEqual(stored([]));
    const disabled = new Set(next.overrides.disabled);
    for (const id of idsIn('dev')) expect(disabled.has(id)).toBe(true);
    // Except the one nobody may decline.
    for (const id of idsIn('meta')) expect(disabled.has(id)).toBe(false);
  });

  it('does not mutate the state it was handed', () => {
    const before = stateWith({ enabledCategories: stored(['search']) });
    const snapshot = JSON.stringify(before);

    pickToState(new Set(['ai']), before);

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('the round trip', () => {
  it('re-opens the picker on exactly the boxes the last pick ticked', () => {
    const picked = new Set(['ai', 'purdue']);

    const written = pickToState(picked, stateWith());

    expect([...initialPicks(written.overrides)].sort()).toEqual([...picked].sort());
  });
});
