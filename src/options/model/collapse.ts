/**
 * Which browse groups are folded away.
 *
 * This is view state, not configuration: it says nothing about what any
 * shortcut does, it is different on every machine the same profile is synced
 * to, and it changes several times a minute. So it lives in `localStorage` and
 * never in `Settings`: putting it in the state blob would make every fold a
 * storage write the background page re-syncs the DNR rules for, and would carry
 * one browser's scroll habits into another's export file.
 *
 * The store is INJECTED rather than read here, and nothing touches
 * `localStorage` at module scope, so the module imports cleanly under vitest's
 * `environment: 'node'` and the logic below is testable without a DOM. The one
 * import is `sectionKey`, which is pure and DOM-free for the same reason.
 */

import { sectionKey } from '../../lib/overrides';

export const COLLAPSE_KEY = 'bunnylol.collapsed';

/** The two `localStorage` methods this needs. Narrowed to what is used so a
 *  test can hand over a Map with two functions on it. */
export interface CollapseStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CollapseState {
  isCollapsed(id: string): boolean;
  set(id: string, collapsed: boolean): void;
  collapseAll(ids: string[]): void;
  expandAll(): void;
  /** Forgets every remembered fold, leaving every group exactly as it starts.
   *  NOT `expandAll`: see the implementation. */
  reset(): void;
  /** Forgets every remembered id that is not in `keep`. */
  prune(keep: string[]): void;
  /** The remembered ids, sorted: for tests and for anything that needs to read
   *  the whole set without a second source of truth. */
  snapshot(): string[];
}

/**
 * Reads the persisted list. The value is a hand-editable string in a store
 * shared with whatever else the extension ever writes, so ANY shape that is not
 * a plain array of strings is answered with "nothing is collapsed" rather than
 * with a partial reading: a half-understood value would fold groups the user
 * never folded and there would be no control to explain it.
 */
export function parseCollapsed(raw: string | null): string[] {
  if (typeof raw !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  if (!parsed.every((entry) => typeof entry === 'string')) return [];
  const ids: string[] = [];
  for (const entry of parsed as string[]) {
    const id = sectionKey(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Sorted and deduped, so the same set of folded groups is the same string and
 *  a diff of the store is a diff of the state. */
export function serializeCollapsed(ids: Iterable<string>): string {
  return JSON.stringify([...new Set(ids)].sort());
}

/**
 * Whether a group's rows are shown, given the live filter and whether the user
 * folded that group.
 *
 * A query force-expands everything: a filter that matched rows inside a folded
 * group and then showed nothing would read as a broken filter. It does not
 * touch the remembered set, so clearing the query folds the group back up.
 */
export function groupExpanded(query: string, collapsed: boolean): boolean {
  return query.trim() !== '' || !collapsed;
}

/**
 * The fold state, seeded from `store`.
 *
 * The persisted set holds the ids whose fold DIFFERS from the default, not the
 * ids that are folded. For every section that is the same thing, since a
 * section starts expanded. It stops being the same thing for a group like
 * "Hidden shortcuts", which starts folded: a set that could only mean "folded"
 * has no way to say the user opened it, so it would spring shut on every load.
 * Storing the departures makes the default the thing that is not written down,
 * which is also what keeps an existing stored list readable: it names sections,
 * and sections still default to open.
 */
export function createCollapseState(
  store: CollapseStore | null,
  defaultCollapsed: string[] = [],
): CollapseState {
  const defaults = new Set(defaultCollapsed.map(sectionKey).filter(Boolean));
  const flipped = new Set<string>(read(store));

  /** The fold, read as the default XOR whether the user moved it. */
  const isFolded = (key: string): boolean => flipped.has(key) !== defaults.has(key);

  /** Records a wanted fold as a departure from the default, so setting a group
   *  back to how it starts forgets it rather than remembering the default. */
  const want = (key: string, folded: boolean): void => {
    if (folded === defaults.has(key)) flipped.delete(key);
    else flipped.add(key);
  };

  // A profile with storage blocked mid-session, a quota that fills, a private
  // window: every one of them throws from a setter that used to work. Folding a
  // group must still fold it: the write is the part that degrades, not the UI.
  const persist = (): void => {
    if (!store) return;
    try {
      store.setItem(COLLAPSE_KEY, serializeCollapsed(flipped));
    } catch {
      // In-memory only from here on.
    }
  };

  return {
    isCollapsed(id: string): boolean {
      return isFolded(sectionKey(id));
    },
    set(id: string, on: boolean): void {
      const wanted = sectionKey(id);
      if (!wanted) return;
      want(wanted, on);
      persist();
    },
    collapseAll(ids: string[]): void {
      for (const id of ids) {
        const wanted = sectionKey(id);
        if (wanted) want(wanted, true);
      }
      persist();
    },
    // Every id, not the ones it was handed: a group that is not on screen right
    // now (its shortcuts are all deleted, its section was removed) would
    // otherwise stay folded forever with no control that reaches it, and
    // "Expand all" is the only thing that could have. What is left is exactly
    // the default-folded groups, since being open is a departure for those.
    expandAll(): void {
      flipped.clear();
      for (const id of defaults) flipped.add(id);
      persist();
    },
    // The other end of `expandAll`, and the reason the two cannot be one
    // function: this forgets the departures instead of recording them, so what
    // is left is the DEFAULT fold, "Hidden shortcuts" folded included. It is
    // what a reset that puts the profile back to how it was installed wants;
    // "Expand all" is a control the user pressed to open things.
    reset(): void {
      flipped.clear();
      persist();
    },
    // Section ids are reused: deleting `Client work` and making another one by
    // the same name mints `sec-client-work` again, and the fold left behind by
    // the first would land on the second as a group the user never folded. The
    // browse list prunes to the groups it actually drew, which is also what
    // clears the fold of a section whose last shortcut was deleted.
    prune(keep: string[]): void {
      const wanted = new Set(keep.map(sectionKey));
      let dropped = false;
      for (const id of [...flipped]) {
        if (wanted.has(id)) continue;
        flipped.delete(id);
        dropped = true;
      }
      // A write per render would be a `localStorage` round trip on every
      // repaint of a page that repaints on every save.
      if (dropped) persist();
    },
    snapshot(): string[] {
      return [...flipped].sort();
    },
  };
}

/**
 * `localStorage` when it is usable, `null` otherwise.
 *
 * Both halves are needed. Under node the property is missing; under a Chrome
 * profile with site data blocked the property is there and THROWS on access,
 * which is why it is read inside the try and then actually touched.
 */
export function safeLocalStorage(): CollapseStore | null {
  try {
    const store = globalThis.localStorage as CollapseStore | undefined;
    if (!store) return null;
    store.getItem(COLLAPSE_KEY);
    return store;
  } catch {
    return null;
  }
}

function read(store: CollapseStore | null): string[] {
  if (!store) return [];
  try {
    return parseCollapsed(store.getItem(COLLAPSE_KEY));
  } catch {
    return [];
  }
}
