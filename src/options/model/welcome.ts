/**
 * What the first-run picker decides, without a DOM. No `document` and no
 * `chrome.*`, so the three questions the page actually answers are testable
 * under node instead of being read off the render: which boxes open ticked,
 * what closing the tab does, and what Continue writes.
 *
 * `src/lib/onboarding.ts` owns what a pick *means*; this owns what the page
 * shows about the pick already on record.
 */

import { BUILTIN_COMMANDS } from '../../lib/commands';
import {
  HIDDEN_CATEGORIES,
  STARTER_CATEGORIES,
  applyCategoryPick,
  categoryPicks,
  hasOnboarded,
} from '../../lib/onboarding';
import type { Overrides, StoredState } from '../../lib/types';

/**
 * Which boxes open ticked.
 *
 * A revisit from Settings shows the answer already on record; a profile that
 * never answered shows the starter set, which is what the install wrote. The
 * hidden packs are stripped because they have no card: `meta` is in every
 * stored pick (nobody may decline the way back to this page) and would
 * otherwise ride along in the Set the checkboxes mutate.
 */
export function initialPicks(overrides: Overrides): Set<string> {
  const hidden = new Set<string>(HIDDEN_CATEGORIES);
  const source = hasOnboarded(overrides)
    ? (overrides.enabledCategories ?? [])
    : STARTER_CATEGORIES;
  return new Set(source.filter((id) => !hidden.has(id)));
}

/**
 * What closing the tab actually does: keyed on the pick that is live, not on
 * whether the picker has been answered.
 *
 * On a real install those two agree, because the starter pick is written
 * before this tab is opened. They come apart everywhere else: a v1 profile
 * arriving from Settings, or an install whose write failed, has no pick at all
 * and so has every shipped shortcut on. Promising it "the starter set" there
 * would be a sentence that is simply untrue.
 */
export function closingLine(overrides: Overrides): string {
  if (!hasOnboarded(overrides)) return 'Closing this tab leaves every shipped pack on.';

  const live = new Set(overrides.enabledCategories ?? []);
  // Off the registry rather than off the stored ids, so the packs are named in
  // the order they are shown and an id with no card is never named.
  const names = categoryPicks(BUILTIN_COMMANDS)
    .filter((row) => live.has(row.id))
    .map((row) => row.label);

  if (names.length === 0) return 'Closing this tab leaves every shipped pack off.';
  return `Closing this tab keeps what is on now: ${names.join(', ')}.`;
}

/**
 * What Continue writes: the ticks, projected onto `disabled` by the
 * authoritative `applyCategoryPick`, with the settings carried through
 * untouched so the page persists both halves in one `storage.local.set`.
 */
export function pickToState(picked: Iterable<string>, state: StoredState): StoredState {
  return {
    overrides: applyCategoryPick(BUILTIN_COMMANDS, [...picked], state.overrides),
    settings: state.settings,
  };
}
