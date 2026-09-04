/**
 * The browse list's collapsed-group state.
 *
 * Importing the module at all is half the test: it must load under vitest's
 * `environment: 'node'`, which is only true if nothing touches `localStorage`
 * or `document` at module scope: the store is injected, and `safeLocalStorage`
 * is a function the page calls rather than a value the module computes.
 */

import { describe, expect, it } from 'vitest';
import { COLLAPSE_KEY, createCollapseState } from '../src/options/model/collapse';
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

describe('createCollapseState', () => {
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

  it('still toggles in memory when the store throws on both reads and writes', () => {
    const state = createCollapseState(throwingStore());
    expect(state.snapshot()).toEqual([]);
    state.set('dev', true);
    expect(state.isCollapsed('dev')).toBe(true);
    state.expandAll();
    expect(state.isCollapsed('dev')).toBe(false);
  });
});
