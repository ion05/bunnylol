/**
 * Hash routing for the options page. The hash carries its own query string
 * (`#new?prefill=x`), so routing parses the hash rather than `location.search`
 * — the `meta` handler turns `bl`, `add foo …` and `set` into
 * `options.html#help`, `#new?prefill=…` and `#settings`.
 *
 * The current route is state, and module-level mutable state belongs in one
 * place (`store.ts`) so a view can never hold a stale copy of it. This module
 * owns only the pure parsing and the hashchange wiring; it never renders
 * anything, so it imports no view.
 */

import { setRoute } from './store';

export type RouteName = 'help' | 'new' | 'edit' | 'settings' | 'welcome';

export interface Route {
  name: RouteName;
  params: URLSearchParams;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const split = raw.indexOf('?');
  const head = (split < 0 ? raw : raw.slice(0, split)).trim().toLowerCase();
  const params = new URLSearchParams(split < 0 ? '' : raw.slice(split + 1));
  const name: RouteName =
    head === 'new' || head === 'add'
      ? 'new'
      : head === 'edit'
        ? 'edit'
        : head === 'settings' || head === 'set'
          ? 'settings'
          : head === 'welcome'
            ? 'welcome'
            : 'help';
  return { name, params };
}

// Two slots, because the monolith's two paths did different things: the
// hashchange handler also synced the browse filter from `?q=`, while `go()`'s
// same-hash path only re-rendered.
let onHashChange: (() => void) | null = null;
let rerender: (() => void) | null = null;

/** Installs the hashchange subscription that `boot()` used to install directly:
 *  parse the new hash into the route, store it, and let the caller decide what
 *  to do next. `onChange` runs on a real hash change; `render` is the
 *  render-only callback `go()` uses below. */
export function startRouter(onChange: () => void, render: () => void): void {
  onHashChange = onChange;
  rerender = render;
  window.addEventListener('hashchange', () => {
    setRoute(parseRoute(location.hash));
    onHashChange?.();
  });
}

/** Navigate. A hash that differs from the current one is assigned to
 *  `location.hash`, so the browser fires `hashchange` and `onChange` runs. An
 *  identical hash fires no event, so this re-parses the route and calls
 *  `render` instead — deliberately not `onChange`, because re-rendering the
 *  page the user is already on must not re-read `?q=` over the filter text
 *  they have typed since. */
export function go(hash: string): void {
  if (location.hash === hash) {
    setRoute(parseRoute(hash));
    rerender?.();
    return;
  }
  location.hash = hash;
}
