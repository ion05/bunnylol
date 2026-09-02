/**
 * First run, as data.
 *
 * The picker asks one question — which packs of shipped shortcuts do you want —
 * and this module is the whole answer to it. It is pure and has no UI in it, so
 * the welcome page, the service worker's update path and the tests all agree on
 * what a pick means.
 *
 * The pick is NOT a second exclusion axis. `enabledCategories` records what the
 * user chose so the picker can be reopened with their answer still ticked, but
 * the effect of choosing is projected onto `Overrides.disabled` at write time by
 * `applyCategoryPick`. The resolver, `activeKeywords`, the DNR rules, the
 * omnibox and the popup therefore inherit it for free and none of them has to
 * learn what a category is.
 */

import type { BuiltinCommand, Category, Command, Overrides } from './types';
import { CATEGORIES, CATEGORY_LABELS } from './types';
import { shortcutId } from './overrides';

/** Ticked when the picker opens: the packs almost everybody wants. */
export const STARTER_CATEGORIES: Category[] = ['search', 'dev', 'ai'];

/** Offered as an opt-in pack, unticked. Purdue is one university's tooling and
 *  is dead weight for everyone else. */
export const OPTIONAL_CATEGORIES: Category[] = ['purdue'];

/** Never offered and never disabled by a pick: `bl`, `add` and `set` are the
 *  address-bar route back to the options page, so a profile that turned them off
 *  could only be fixed through the toolbar. */
export const ALWAYS_ON_CATEGORIES: Category[] = ['meta'];

/** Not shown in the picker. `meta` is always on, and `custom` holds the user's
 *  own shortcuts, which are not a pack anybody can decline. */
export const HIDDEN_CATEGORIES: Category[] = ['meta', 'custom'];

/** One row of the picker, derived from the registry rather than restated — a
 *  pack whose count is written down by hand is a pack that goes stale. */
export interface PickRow {
  id: string;
  label: string;
  count: number;
  /** The first three canonical keywords, as a hint at what is in the pack. */
  sample: string[];
  /** Every shortcut in the pack, in registry order, so the card can unfold
   *  and show what a tick actually turns on. */
  members: PickMember[];
  starter: boolean;
  optional: boolean;
}

/** One shortcut as the picker lists it: enough to recognise it, nothing the
 *  page would have to keep in step with the registry by hand. */
export interface PickMember {
  id: string;
  keys: string[];
  name: string;
  description: string;
}

/**
 * What a pick actually enables: what the user ticked, plus the packs they are
 * not allowed to decline, deduped and in registry order so two equivalent picks
 * produce the same stored array.
 *
 * An id outside `CATEGORIES` is dropped rather than kept: a pick names shipped
 * packs, and a user section holds no builtins for it to have an effect on.
 */
export function effectiveCategories(picked: readonly string[] | null | undefined): string[] {
  const wanted = new Set<string>(ALWAYS_ON_CATEGORIES);
  for (const entry of picked ?? []) {
    if (typeof entry === 'string') wanted.add(entry.trim().toLowerCase());
  }
  return CATEGORIES.filter((category) => wanted.has(category));
}

/**
 * The single "has this profile seen the picker" signal.
 *
 * `seenBuiltins` deliberately does not answer this: it says which ids have been
 * offered, which the update migration needs and the picker does not, and the
 * two diverge the first time an update runs on a profile that never onboarded.
 */
export function hasOnboarded(overrides: Overrides | null | undefined): boolean {
  return (overrides?.enabledCategories ?? null) !== null;
}

/**
 * Writes a pick. AUTHORITATIVE: every shipped shortcut in a picked pack ends up
 * ON and every one outside it ends up OFF, so re-running the picker RE-ENABLES
 * shortcuts the user had turned off by hand inside a pack they pick again. That
 * is the documented behaviour of the welcome page rather than an accident —
 * "these are the packs I want" has to mean something, and the page says so.
 *
 * `deleted` is untouched: a shortcut the user deleted stays deleted through a
 * re-pick, and comes back from Settings → Restore. Ids in `disabled` that name
 * a custom command are untouched too, because a pack is a set of builtins and
 * nothing here walks the user's own shortcuts.
 *
 * The category read is the SHIPPED one off `builtins`, not the edited one: the
 * packs are what the registry ships, so moving `gh` into a section of your own
 * does not move it out of the Developer pack.
 */
export function applyCategoryPick(
  builtins: Command[],
  picked: readonly string[],
  current: Overrides,
): Overrides {
  const enabled = effectiveCategories(picked);
  const allowed = new Set(enabled);
  const disabled = new Set(current.disabled);
  const seen = new Set(current.seenBuiltins);

  for (const cmd of builtins ?? []) {
    const id = shortcutId(cmd);
    if (!id) continue;
    seen.add(id);
    if (allowed.has(cmd.category)) disabled.delete(id);
    else disabled.add(id);
  }

  return {
    ...current,
    disabled: [...disabled],
    enabledCategories: enabled,
    seenBuiltins: [...seen],
  };
}

/**
 * Folds builtins added since this profile last looked into the user's pick,
 * instead of switching them all on regardless of what they chose.
 *
 * Returns its input BY REFERENCE when there is nothing new, so the update path
 * can skip the write — and therefore the `syncRules` round trip it would
 * trigger — with an identity check rather than a deep compare.
 *
 * FAILS OPEN: a profile that never saw the picker (`enabledCategories === null`)
 * has no pick to fold anything into, so nothing is ever disabled here. It only
 * records the ids as seen, so the first real pick is still the authority.
 */
export function migrateNewBuiltins(builtins: Command[], current: Overrides): Overrides {
  const seen = new Set(current.seenBuiltins);
  const fresh = (builtins ?? []).filter((cmd) => {
    const id = shortcutId(cmd);
    return id !== '' && !seen.has(id);
  });
  if (fresh.length === 0) return current;

  const enabled = current.enabledCategories;
  const disabled = new Set(current.disabled);
  const allowed = enabled === null ? null : new Set(effectiveCategories(enabled));

  for (const cmd of fresh) {
    const id = shortcutId(cmd);
    seen.add(id);
    if (allowed && !allowed.has(cmd.category)) disabled.add(id);
  }

  return { ...current, disabled: [...disabled], seenBuiltins: [...seen] };
}

/**
 * The picker's rows, straight off the registry: the shipped packs that hold
 * something, in registry order, minus the ones nobody gets to decline.
 */
export function categoryPicks(builtins: BuiltinCommand[]): PickRow[] {
  const hidden = new Set<string>(HIDDEN_CATEGORIES);
  const starter = new Set<string>(STARTER_CATEGORIES);
  const optional = new Set<string>(OPTIONAL_CATEGORIES);

  return CATEGORIES.filter((category) => !hidden.has(category))
    .map((category) => {
      const members = (builtins ?? [])
        .filter((cmd) => cmd.category === category)
        .map((cmd) => ({
          id: shortcutId(cmd),
          keys: [...cmd.keys],
          name: cmd.name,
          description: cmd.description,
        }));
      return {
        id: category,
        label: CATEGORY_LABELS[category],
        count: members.length,
        sample: members.slice(0, 3).map((member) => member.keys[0]),
        members,
        starter: starter.has(category),
        optional: optional.has(category),
      };
    })
    // A pack with nothing in it is a checkbox that does nothing. This build
    // ships none, and `tests/commands.test.ts` says so, but a category removed
    // down to zero commands should disappear from the picker rather than sit
    // there as an empty promise.
    .filter((row) => row.count > 0);
}
