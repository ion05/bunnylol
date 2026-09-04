/**
 * The shortcut manager: the page's entry point.
 *
 * This file owns `boot()` (load state, install the hooks the store and the
 * router need, subscribe to storage), the echo guard that keeps our own writes
 * from repainting a half-typed form, and the `render`/`renderView` dispatch
 * into `views/`. Routing lives in `router.ts`, state in `store.ts`; every view
 * is a module under `views/` and none of them reaches back into this one.
 */

import { loadState, onStateChanged } from '../lib/storage';
import { el } from '../ui/dom';
import { button } from './dom';
import type { RouteName } from './router';
import { go, parseRoute, startRouter } from './router';
import {
  paintStatus,
  refreshStatus,
  resync,
  scheduleStatusRefresh,
  setResyncButton,
  setStatusHost,
  resetHosts,
} from './rule-status';
import {
  applyState,
  getLastRoute,
  getRoute,
  getState,
  setAfterCommit,
  setFilter,
  setLastRoute,
  setRoute,
  setStatusPainter,
} from './store';
import { renderBrowse } from './views/browse';
import { renderForm } from './views/form';
import { renderPacks } from './views/packs';
import { renderSettings } from './views/settings';
import { renderWelcome } from './views/welcome';

const root = document.getElementById('app') ?? document.body;

void boot();

async function boot(): Promise<void> {
  applyState(await loadState());
  setRoute(parseRoute(location.hash));
  setFilter(getRoute().name === 'help' ? (getRoute().params.get('q') ?? '') : '');

  // Installed before the first render, not after. All three are nullable slots
  // in `store.ts` and `router.ts` that no-op while they are empty, and the view
  // that first render builds can already commit or navigate, so a hook
  // installed afterwards would swallow that first commit and that first
  // navigation without a word.
  setAfterCommit(scheduleStatusRefresh);
  setStatusPainter(paintStatus);
  startRouter(onRouteChange, render);

  render();

  window.addEventListener('keydown', onGlobalKey);

  onStateChanged((next) => {
    // Our own writes come straight back through this listener. Comparing
    // against what we already applied optimistically is what tells the echo
    // apart from a change made in the popup or another window.
    const echo = JSON.stringify(next) === JSON.stringify(getState());
    applyState(next);
    if (echo) return;
    // Re-rendering under a half-typed shortcut would discard it; `applyState`
    // has already refreshed what the preview and the validator read. The
    // welcome picker is the same hazard: its ticks live in a Set that belongs
    // to the render, so a write from another window would repaint the page
    // with boxes the user did not tick. `packs` is that same picker.
    const route = getRoute().name;
    if (route === 'new' || route === 'edit' || route === 'welcome' || route === 'packs') return;
    // Same hazard on every other route: the settings fields only commit on
    // blur, so repainting the one the user is inside throws their text away.
    if (isTextEntry(document.activeElement)) return;
    render();
  });

  void refreshStatus();
}

/** What `router.ts`'s hashchange listener runs after it updates the route: sync
 *  the browse filter from `?q=`, then re-render. `go()`'s same-hash path is
 *  deliberately given `render` instead of this, because re-rendering the page
 *  the user is already on must not re-read `?q=` over the filter text they have
 *  typed since. */
function onRouteChange(): void {
  const route = getRoute();
  if (route.name === 'help' && route.params.has('q')) setFilter(route.params.get('q') ?? '');
  render();
}

function isTextEntry(node: Element | null): boolean {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement
  );
}

function onGlobalKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
  const route = getRoute();

  if (event.key === 'Escape' && (route.name === 'new' || route.name === 'edit')) {
    event.preventDefault();
    go('#help');
    return;
  }
  if (event.key === '/' && route.name === 'help' && !typing) {
    const filter = document.getElementById('filter');
    if (filter instanceof HTMLInputElement) {
      event.preventDefault();
      filter.focus();
      filter.select();
    }
  }
}

// ---------------------------------------------------------------- render ----

function render(): void {
  const scroll = window.scrollY;
  const sameRoute = getLastRoute() === getRoute().name;
  setLastRoute(getRoute().name);

  // Live-region hosts belong to the nodes about to be thrown away (see
  // `resetHosts`).
  resetHosts();
  root.textContent = '';
  const shell = el('main', { class: 'shell' });
  shell.append(...renderView());
  root.append(renderTopbar(), shell, renderFooter());
  paintStatus();
  window.scrollTo({ top: sameRoute ? scroll : 0 });
}

function renderView(): Node[] {
  const route = getRoute();
  if (route.name === 'settings') return renderSettings();
  if (route.name === 'new' || route.name === 'edit') return [renderForm()];
  if (route.name === 'welcome') return renderWelcome();
  if (route.name === 'packs') return renderPacks();
  return renderBrowse();
}

function renderTopbar(): HTMLElement {
  // No class and no content until `paintStatus` has something to report: the
  // pill is silent on a healthy profile, which is most of them.
  const statusHost = el('span', { attrs: { role: 'status', 'aria-live': 'polite' } });
  statusHost.hidden = true;
  setStatusHost(statusHost);
  const resyncButton = button('Re-sync', () => void resync(), 'btn btn-sm');
  resyncButton.title = 'Rebuild the redirect rules from your current shortcuts';
  setResyncButton(resyncButton);

  // The wordmark goes straight into the bar's flex row: the bar is left-packed,
  // so the pattern's `.brand` wrapper would be a div with nothing to say.
  const brandName = el('h1', { class: 'brand-name', text: 'BunnyLol' });

  const nav = el('nav', { class: 'nav', attrs: { 'aria-label': 'Sections' } });
  const tabs: { hash: string; label: string; match: RouteName[] }[] = [
    { hash: '#help', label: 'Shortcuts', match: ['help'] },
    { hash: '#new', label: 'New shortcut', match: ['new', 'edit'] },
    // `#packs` is reached from the Settings row and is a Settings screen, so
    // the tab it came from stays lit while the user is on it. `#welcome` lights
    // nothing: the install opens it, not a tab.
    { hash: '#settings', label: 'Settings', match: ['settings', 'packs'] },
  ];
  for (const tab of tabs) {
    const link = el('a', { class: 'nav-link', text: tab.label });
    link.href = tab.hash;
    if (tab.match.includes(getRoute().name)) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }

  return el('header', {
    class: 'topbar',
    children: [
      // The status and Re-sync sit directly in the bar's flex row: `.status` is
      // the status component itself now, so a wrapper wearing that class would
      // put the button inside a 48ch box meant for one line of text.
      el('div', {
        class: 'topbar-inner',
        children: [brandName, statusHost, resyncButton, nav],
      }),
    ],
  });
}

function footerLink(href: string, text: string): HTMLAnchorElement {
  const link = el('a', { text });
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function renderFooter(): HTMLElement {
  return el('footer', {
    class: 'footer',
    children: [
      el('div', {
        class: 'footer-inner',
        children: [
          'Built by ',
          footerLink('https://aayanagarwal.com/', 'Aayan Agarwal'),
          ' · ',
          footerLink('https://github.com/ion05/bunnylol', 'GitHub'),
        ],
      }),
    ],
  });
}
