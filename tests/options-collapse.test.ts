/**
 * The browse list's collapsed-group state.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`, which is only true if nothing touches `localStorage`
 * or `document` at module scope: the store is injected, and `safeLocalStorage`
 * is a function the page calls rather than a value the module computes.
 */

import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_KEY,
  createCollapseState,
  groupExpanded,
  parseCollapsed,
  safeLocalStorage,
  serializeCollapsed,
} from '../src/options/model/collapse';
import type { CollapseStore } from '../src/options/model/collapse';

/** A `localStorage` the size of what `CollapseStore` asks for. */
function fakeStore(initial?: string): CollapseStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(COLLAPSE_KEY, initial);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function throwingStore(): CollapseStore {
  return {
    getItem() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
    setItem() {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    },
  };
}

describe('parseCollapsed', () => {
  it('reads a valid array of ids', () => {
    expect(parseCollapsed('["dev","social"]')).toEqual(['dev', 'social']);
  });

  it('answers [] for null, for junk, for a bare string and for an object', () => {
    expect(parseCollapsed(null)).toEqual([]);
    expect(parseCollapsed('')).toEqual([]);
    expect(parseCollapsed('not json at all')).toEqual([]);
    expect(parseCollapsed('"dev"')).toEqual([]);
    expect(parseCollapsed('{"dev":true}')).toEqual([]);
    expect(parseCollapsed('42')).toEqual([]);
  });

  it('refuses the whole array when any entry is not a string', () => {
    // A partial reading would fold groups the user never folded, and there is
    // no control on the page that explains where that came from.
    expect(parseCollapsed('["dev",7]')).toEqual([]);
    expect(parseCollapsed('["dev",null]')).toEqual([]);
    expect(parseCollapsed('["dev",{"id":"social"}]')).toEqual([]);
  });

  it('normalises the ids it keeps the way overrides.ts compares them', () => {
    expect(parseCollapsed('[" Dev ","dev","","social"]')).toEqual(['dev', 'social']);
  });
});

describe('serializeCollapsed', () => {
  it('sorts and dedupes, so one set of folded groups is one string', () => {
    expect(serializeCollapsed(['social', 'dev', 'social'])).toBe('["dev","social"]');
    expect(serializeCollapsed(new Set(['dev', 'social']))).toBe(
      serializeCollapsed(['social', 'dev']),
    );
  });

  it('round-trips through parseCollapsed', () => {
    const ids = ['ai', 'custom', 'sec-work'];
    expect(parseCollapsed(serializeCollapsed(ids))).toEqual(ids);
  });
});

describe('groupExpanded', () => {
  it('shows an unfolded group and hides a folded one when nothing is typed', () => {
    expect(groupExpanded('', false)).toBe(true);
    expect(groupExpanded('', true)).toBe(false);
    expect(groupExpanded('   ', true)).toBe(false);
  });

  it('force-expands every group while a filter is live', () => {
    // A filter that matched rows inside a folded group and then showed nothing
    // reads as a filter that does not work.
    expect(groupExpanded('git', true)).toBe(true);
    expect(groupExpanded('git', false)).toBe(true);
  });
});

describe('createCollapseState', () => {
  it('reports everything expanded from an empty store', () => {
    const state = createCollapseState(fakeStore());
    expect(state.isCollapsed('dev')).toBe(false);
    expect(state.snapshot()).toEqual([]);
  });

  it('seeds itself from what the store already holds', () => {
    const state = createCollapseState(fakeStore('["dev"]'));
    expect(state.isCollapsed('dev')).toBe(true);
    expect(state.isCollapsed('social')).toBe(false);
  });

  it('persists a fold under bunnylol.collapsed and forgets it when unfolded', () => {
    const store = fakeStore();
    const state = createCollapseState(store);

    state.set('dev', true);
    expect(store.map.get(COLLAPSE_KEY)).toBe('["dev"]');
    expect(createCollapseState(store).isCollapsed('dev')).toBe(true);

    state.set('dev', false);
    expect(store.map.get(COLLAPSE_KEY)).toBe('[]');
    expect(createCollapseState(store).isCollapsed('dev')).toBe(false);
  });

  it('matches ids case- and whitespace-insensitively', () => {
    const state = createCollapseState(fakeStore());
    state.set(' Dev ', true);
    expect(state.isCollapsed('dev')).toBe(true);
    expect(state.snapshot()).toEqual(['dev']);
  });

  it('ignores an empty id rather than folding a group called ""', () => {
    const state = createCollapseState(fakeStore());
    state.set('   ', true);
    expect(state.snapshot()).toEqual([]);
  });

  it('collapseAll folds exactly the ids it is handed, and expandAll clears them all', () => {
    const store = fakeStore();
    const state = createCollapseState(store);

    state.collapseAll(['dev', 'social', 'ai']);
    expect(state.snapshot()).toEqual(['ai', 'dev', 'social']);
    expect(state.isCollapsed('custom')).toBe(false);

    state.expandAll();
    expect(state.snapshot()).toEqual([]);
    expect(store.map.get(COLLAPSE_KEY)).toBe('[]');
  });

  it('expandAll also clears a group that is no longer on the page', () => {
    // A section that has since been deleted would otherwise stay folded with no
    // control left that could reach it.
    const state = createCollapseState(fakeStore('["sec-gone","dev"]'));
    state.expandAll();
    expect(state.snapshot()).toEqual([]);
  });

  it('prune forgets a fold whose group is no longer drawn', () => {
    // The bug: a section id is minted from its label, so deleting `Client work`
    // and making another one by the same name mints `sec-client-work` again,
    // and the first one's fold lands on the second as a group the user never
    // folded.
    const store = fakeStore('["sec-client-work","dev"]');
    const state = createCollapseState(store);

    state.prune(['custom', 'dev', 'social']);
    expect(state.snapshot()).toEqual(['dev']);
    expect(state.isCollapsed('sec-client-work')).toBe(false);
    expect(store.map.get(COLLAPSE_KEY)).toBe('["dev"]');
  });

  it('prune reads the ids it keeps the way every other method does', () => {
    const state = createCollapseState(fakeStore('["dev"]'));
    state.prune([' DEV ']);
    expect(state.snapshot()).toEqual(['dev']);
  });

  it('prune to nothing clears the set, and writes only when something moved', () => {
    const store = fakeStore('["dev"]');
    const state = createCollapseState(store);

    state.prune(['dev']);
    // Nothing dropped, so nothing is written: this runs on every repaint of a
    // page that repaints on every save.
    expect(store.map.get(COLLAPSE_KEY)).toBe('["dev"]');
    store.map.set(COLLAPSE_KEY, 'sentinel');
    state.prune(['dev']);
    expect(store.map.get(COLLAPSE_KEY)).toBe('sentinel');

    state.prune([]);
    expect(state.snapshot()).toEqual([]);
    expect(store.map.get(COLLAPSE_KEY)).toBe('[]');
  });

  it('a default-collapsed group starts folded and remembers being opened', () => {
    // "Hidden shortcuts" is the group this exists for. The persisted set holds
    // the ids whose fold DIFFERS from the default, so opening this one is what
    // gets written down and closing it again is what gets forgotten.
    const store = fakeStore();
    const state = createCollapseState(store, ['@hidden']);
    expect(state.isCollapsed('@hidden')).toBe(true);
    expect(state.isCollapsed('dev')).toBe(false);

    state.set('@hidden', false);
    expect(state.isCollapsed('@hidden')).toBe(false);
    expect(store.map.get(COLLAPSE_KEY)).toBe('["@hidden"]');
    expect(createCollapseState(store, ['@hidden']).isCollapsed('@hidden')).toBe(false);

    state.set('@hidden', true);
    expect(state.isCollapsed('@hidden')).toBe(true);
    expect(store.map.get(COLLAPSE_KEY)).toBe('[]');
  });

  it('Expand all opens a default-collapsed group, Collapse all puts it back', () => {
    const store = fakeStore();
    const state = createCollapseState(store, ['@hidden']);

    state.expandAll();
    expect(state.isCollapsed('@hidden')).toBe(false);
    expect(state.isCollapsed('dev')).toBe(false);

    state.collapseAll(['dev', '@hidden']);
    expect(state.isCollapsed('@hidden')).toBe(true);
    expect(state.isCollapsed('dev')).toBe(true);
    // Only the section is written down: the other one is folded by default.
    expect(store.map.get(COLLAPSE_KEY)).toBe('["dev"]');
  });

  it('prune forgets that a default-collapsed group was opened', () => {
    // The hidden group counts as drawn only while something is in it, so a
    // profile that switches its last hidden shortcut back on gets the folded
    // default again when the group next appears.
    const store = fakeStore('["@hidden"]');
    const state = createCollapseState(store, ['@hidden']);
    expect(state.isCollapsed('@hidden')).toBe(false);
    state.prune(['dev']);
    expect(state.isCollapsed('@hidden')).toBe(true);
  });

  it('still toggles in memory when the store throws on both reads and writes', () => {
    const state = createCollapseState(throwingStore());
    expect(state.snapshot()).toEqual([]);
    state.set('dev', true);
    expect(state.isCollapsed('dev')).toBe(true);
    state.expandAll();
    expect(state.isCollapsed('dev')).toBe(false);
  });

  it('never throws without a store at all', () => {
    const state = createCollapseState(null);
    expect(() => {
      state.set('dev', true);
      state.collapseAll(['social']);
      state.prune(['social']);
      state.expandAll();
    }).not.toThrow();
    expect(state.snapshot()).toEqual([]);
  });

  it('keeps folds in memory without a store, so the page still works', () => {
    const state = createCollapseState(null);
    state.set('dev', true);
    expect(state.isCollapsed('dev')).toBe(true);
  });
});

describe('safeLocalStorage', () => {
  /** Swaps `globalThis.localStorage` for the property descriptor a given
   *  environment would present, and always puts the real one back. */
  function withLocalStorage(descriptor: PropertyDescriptor, run: () => void): void {
    const owner = globalThis as { localStorage?: unknown };
    const original = Object.getOwnPropertyDescriptor(owner, 'localStorage');
    Object.defineProperty(owner, 'localStorage', { configurable: true, ...descriptor });
    try {
      run();
    } finally {
      if (original) Object.defineProperty(owner, 'localStorage', original);
      else delete owner.localStorage;
    }
  }

  it('answers null where there is no localStorage at all, as under node', () => {
    withLocalStorage({ value: undefined, writable: true }, () => {
      expect(safeLocalStorage()).toBeNull();
    });
  });

  it('answers null when reading the property throws, as a blocked profile does', () => {
    withLocalStorage(
      {
        get() {
          throw new DOMException('Access is denied for this document.', 'SecurityError');
        },
      },
      () => {
        expect(safeLocalStorage()).toBeNull();
      },
    );
  });

  it('answers null when the property is there but using it throws', () => {
    // The property existing is not the question the caller has: a profile with
    // site data blocked hands over an object whose every method throws.
    withLocalStorage({ value: throwingStore(), writable: true }, () => {
      expect(safeLocalStorage()).toBeNull();
    });
  });

  it('answers the store when one is usable', () => {
    const store = fakeStore();
    withLocalStorage({ value: store, writable: true }, () => {
      expect(safeLocalStorage()).toBe(store);
    });
  });
});
