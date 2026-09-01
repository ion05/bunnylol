/**
 * The dispatch page. Every intercepted address-bar query lands here, resolves,
 * and leaves again before it can be seen. Nothing renders on the happy path —
 * except a placeholder for a storage read slow enough to be noticed.
 */

import { expandTemplate, isBouncedUrl, resolve, stripPassthrough, withPassthrough } from '../lib/resolve';
import { loadResolveContext } from '../lib/storage';
import { toNavigableUrl } from '../lib/url';
import type { Settings } from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';

/** Both what we will navigate to and what we will render as a link. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'chrome-extension:']);

/**
 * Long enough that a warm `chrome.storage` read redirects first, so the normal
 * case still shows nothing at all.
 */
const STATUS_DELAY_MS = 150;

/**
 * How long the dispatch toast holds the navigation when `settings.dispatchToast`
 * is on.
 *
 * IT REALLY DOES HOLD IT, and that is why the setting ships OFF. The intent was
 * a toast rendered here and then seen on the DESTINATION page, but nothing in
 * this document survives `location.replace` — showing a banner on the page we
 * navigate to would mean a content script on every site the user visits, which
 * is a permission the feature does not justify. So the honest version is an
 * opt-in delay: a user who keeps mistyping into commands can pay 1.2s per
 * dispatch to see what fired and click through to a search instead, and
 * everybody else keeps the fast path.
 */
const TOAST_MS = 1200;

/**
 * The settings the failing dispatch was working from, so the error page can
 * offer the user's own engine rather than a hardcoded one. Stays at the
 * defaults when it is the storage read itself that failed.
 */
let settings: Settings = DEFAULT_SETTINGS;

let statusTimer: ReturnType<typeof setTimeout> | undefined;

async function dispatch(query: string): Promise<void> {
  const context = await loadResolveContext();
  settings = context.settings;
  const result = resolve(query, context.commands, settings);
  const target = new URL(toNavigableUrl(result.url));

  // Custom shortcuts are user-editable text, so a `javascript:` or `data:`
  // template can reach this line. Refuse anything we would not have built.
  if (!SAFE_PROTOCOLS.has(target.protocol)) {
    throw new Error(`Refusing to open a ${target.protocol} URL.`);
  }
  if (target.protocol === 'chrome-extension:' && target.origin !== location.origin) {
    throw new Error('Refusing to open a page belonging to another extension.');
  }

  // The default path never touches the DOM: no toast, no reflow, straight out.
  if (settings.dispatchToast && result.command) await announce(query, target);

  // replace(), not assign(): this page never enters history, so Back returns to
  // wherever the user was when they typed the query.
  location.replace(target.href);
}

/**
 * "gh → github.com · search instead", for `TOAST_MS`, then resolve so the caller
 * navigates. Resolves early when the user dismisses it, and never resolves once
 * they click through to a search — that anchor's own navigation is the outcome,
 * and letting the timer fire too would race it.
 */
function announce(query: string, target: URL): Promise<void> {
  const host = document.getElementById('toast');
  if (!host) return Promise.resolve();
  hideStatus();

  return new Promise<void>((navigate) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) navigate();
    }, TOAST_MS);
    const stop = (): void => {
      done = true;
      clearTimeout(timer);
    };

    const search = link(searchUrl(query), 'search instead');
    // The anchor navigates on its own; we only have to stop competing with it.
    search.addEventListener('click', stop);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '\u00d7';
    dismiss.setAttribute('aria-label', 'Dismiss and continue');
    dismiss.className = 'toast-x';
    dismiss.addEventListener('click', () => {
      stop();
      navigate();
    });

    host.replaceChildren(
      el('strong', firstWord(query)),
      el('span', ' \u2192 '),
      el('span', destinationLabel(target)),
      el('span', ' \u00b7 '),
      search,
      dismiss,
    );
    host.hidden = false;
  });
}

function el(tag: 'strong' | 'span', text: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

/** The alias that fired. A command matched, so the first token is that alias. */
function firstWord(query: string): string {
  const trimmed = query.trim();
  const boundary = trimmed.search(/\s/);
  return boundary < 0 ? trimmed : trimmed.slice(0, boundary);
}

function destinationLabel(target: URL): string {
  if (target.protocol === 'chrome-extension:') return 'BunnyLol';
  return target.hostname.replace(/^www\./, '');
}

function fail(query: string, error: unknown): void {
  hideStatus();
  hideToast();
  // The error page is the only thing left; render it into the body rather than
  // leave a blank window if `#err` was edited away.
  const box = document.getElementById('err') ?? document.body;

  const title = document.createElement('h1');
  title.style.cssText = 'font-size:16px;font-weight:600;margin:0 0 12px';
  title.textContent = 'BunnyLol could not open that';

  const echo = document.createElement('p');
  echo.style.cssText = 'margin:0 0 8px;opacity:.85';
  const code = document.createElement('code');
  code.textContent = query || '(empty query)';
  echo.append('You typed ', code);

  const why = document.createElement('p');
  why.style.cssText = 'margin:0 0 20px;opacity:.65';
  why.textContent = (error instanceof Error ? error.message : String(error)) || 'Unknown error.';

  const actions = document.createElement('p');
  actions.style.cssText = 'margin:0';
  actions.append(
    link(searchUrl(query), 'Search for it instead'),
    ' · ',
    link(optionsUrl(), 'BunnyLol settings'),
  );

  box.replaceChildren(title, echo, why, actions);
  box.style.display = 'block';
  // `#wrap`'s padding went with it in the body fallback.
  if (box === document.body) box.style.padding = '24px';
}

/**
 * The escape hatch out of this page. It carries the passthrough marker because
 * without it the DNR rule that sent the query here catches the search too and
 * bounces the user straight back to this same error.
 */
function searchUrl(query: string): string {
  const engine = settings.defaultEngine || DEFAULT_SETTINGS.defaultEngine;
  return safeHref(
    withPassthrough(expandTemplate(engine, query)),
    withPassthrough(expandTemplate(DEFAULT_SETTINGS.defaultEngine, query)),
  );
}

/**
 * `defaultEngine` is user-editable text, so a `javascript:` template would
 * otherwise become a link that runs script in the extension's own origin.
 */
function safeHref(href: string, fallback: string): string {
  try {
    if (SAFE_PROTOCOLS.has(new URL(href, location.href).protocol)) return href;
  } catch {
    // Not a parseable URL — no better guess than the fallback.
  }
  return fallback;
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.style.cssText = 'color:inherit';
  return a;
}

function optionsUrl(): string {
  try {
    return chrome.runtime.getURL('options.html');
  } catch {
    return 'options.html';
  }
}

function showStatus(): void {
  const status = document.getElementById('status');
  if (status) status.hidden = false;
}

function hideStatus(): void {
  clearTimeout(statusTimer);
  const status = document.getElementById('status');
  if (status) status.hidden = true;
}

function hideToast(): void {
  const toast = document.getElementById('toast');
  if (toast) toast.hidden = true;
}

const params = new URLSearchParams(location.search);
const raw = params.get('q') ?? params.get('query');

if (raw === null) {
  // Someone opened go.html directly; the options page is the only useful
  // destination we can guess.
  location.replace(optionsUrl());
} else {
  // Only a genuinely bounced url gets the marker stripped. Running
  // stripPassthrough over arbitrary text would delete a literal `&blpass=1`
  // the user actually typed — `gh foo&blpass=1` would search for `gh foo` —
  // and the rule layer already guarantees a marked url is never redirected
  // here: fitPlan refuses to register an engine's redirect rules unless
  // Chrome accepted its allow rule too.
  const query = isBouncedUrl(raw) ? stripPassthrough(raw) : raw;
  statusTimer = setTimeout(showStatus, STATUS_DELAY_MS);
  dispatch(query).catch((error) => fail(query, error));
}
