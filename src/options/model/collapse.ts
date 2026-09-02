/**
 * Which browse groups are folded away.
 *
 * This is view state, not configuration: it says nothing about what any
 * shortcut does, it is different on every machine the same profile is synced
 * to, and it changes several times a minute. So it lives in `localStorage` and
 * never in `Settings` — putting it in the state blob would make every fold a
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
  /** Forgets every collapsed id that is not in `keep`. */
  prune(keep: string[]): void;
  /** The collapsed ids, sorted — for tests and for anything that needs to read
   *  the whole set without a second source of truth. */
  snapshot(): string[];
}

/**
 * Reads the persisted list. The value is a hand-editable string in a store
 * shared with whatever else the extension ever writes, so ANY shape that is not
 * a plain array of strings is answered with "nothing is collapsed" rather than
 * with a partial reading — a half-understood value would fold groups the user
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

export function createCollapseState(store: CollapseStore | null): CollapseState {
  const collapsed = new Set<string>(read(store));

  // A profile with storage blocked mid-session, a quota that fills, a private
  // window: every one of them throws from a setter that used to work. Folding a
  // group must still fold it — the write is the part that degrades, not the UI.
  const persist = (): void => {
    if (!store) return;
    try {
      store.setItem(COLLAPSE_KEY, serializeCollapsed(collapsed));
    } catch {
      // In-memory only from here on.
    }
  };

  return {
    isCollapsed(id: string): boolean {
      return collapsed.has(sectionKey(id));
    },
    set(id: string, on: boolean): void {
      const wanted = sectionKey(id);
      if (!wanted) return;
      if (on) collapsed.add(wanted);
      else collapsed.delete(wanted);
      persist();
    },
    collapseAll(ids: string[]): void {
      for (const id of ids) {
        const wanted = sectionKey(id);
        if (wanted) collapsed.add(wanted);
      }
      persist();
    },
    // Clears the whole set rather than the ids it was handed: a group that is
    // not on screen right now (its shortcuts are all deleted, its section was
    // removed) would otherwise stay folded forever with no control that reaches
    // it, and "Expand all" is the only thing that could have.
    expandAll(): void {
      collapsed.clear();
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
      for (const id of [...collapsed]) {
        if (wanted.has(id)) continue;
        collapsed.delete(id);
        dropped = true;
      }
      // A write per render would be a `localStorage` round trip on every
      // repaint of a page that repaints on every save.
      if (dropped) persist();
    },
    snapshot(): string[] {
      return [...collapsed].sort();
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
