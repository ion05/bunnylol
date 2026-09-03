/**
 * What the pack picker decides, without a DOM. No `document` and no `chrome.*`,
 * so the two questions the page actually answers are testable under node
 * instead of being read off the render: which boxes open ticked, and what the
 * confirming button writes.
 *
 * Both pack screens read this one: `#welcome` on first run and `#packs` from
 * Settings ask the same question and write the same answer, and only the words
 * around them differ (`views/packs.ts`).
 *
 * `src/lib/onboarding.ts` owns what a pick *means*; this owns what the page
 * shows about the pick already on record.
 */

import { BUILTIN_COMMANDS } from '../../lib/commands';
import {
  HIDDEN_CATEGORIES,
  STARTER_CATEGORIES,
  applyCategoryPick,
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
