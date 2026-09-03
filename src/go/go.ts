/**
 * The dispatch page. Every intercepted address-bar query lands here, resolves,
 * and leaves again before it can be seen. Nothing renders on the happy path,
 * except a placeholder for a storage read slow enough to be noticed.
 *
 * `settings.dispatchToast`, "Confirm before opening a shortcut", is the one
 * exception, and it is opt-in. It stops the dispatch and shows what resolved,
 * the alias that fired and the URL it is going to, with a button that opens it
 * and a link that searches for what was typed instead. It waits for the user:
 * there is no timer, because a confirmation the page navigates away from on its
 * own is not a confirmation, it is a delay.
 */

import { expandTemplate, isBouncedUrl, resolve, stripPassthrough, withPassthrough } from '../lib/resolve';
import { loadResolveContext } from '../lib/storage';
import { errorText, firstToken } from '../lib/text';
import { toNavigableUrl } from '../lib/url';
import type { Settings } from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';
import { el } from '../ui/dom';

/** Both what we will navigate to and what we will render as a link. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'chrome-extension:']);

/**
 * Long enough that a warm `chrome.storage` read redirects first, so the normal
 * case still shows nothing at all.
 */
const STATUS_DELAY_MS = 150;

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

  // The default path never touches the DOM: no confirmation, no reflow,
  // straight out.
  if (settings.dispatchToast && result.command) {
    await confirmOpen(query, target, result.command.name);
  }

  // replace(), not assign(): this page never enters history, so Back returns to
  // wherever the user was when they typed the query.
  location.replace(target.href);
}

/**
 * The confirmation: what fired, where it goes, and the two ways out. Resolves
 * when the user asks for the navigation, and never resolves if they take the
 * search link instead, because that anchor's own navigation is the outcome and
 * a second one would race it.
 *
 * The Open button takes focus, so the whole interaction is one Enter for a user
 * who is reading rather than reaching for the mouse.
 */
function confirmOpen(query: string, target: URL, name: string): Promise<void> {
  const host = document.getElementById('confirm');
  if (!host) return Promise.resolve();
  hideStatus();

  return new Promise<void>((navigate) => {
    const proceed = document.createElement('button');
    proceed.type = 'button';
    proceed.className = 'confirm-go';
    proceed.textContent = `Open ${destinationLabel(target)}`;
    proceed.addEventListener('click', () => navigate());

    const what = el('p', {
      class: 'confirm-what',
      id: 'confirm-what',
      children: [
        // The alias that fired: a command matched, so the first token is that alias.
        el('code', { text: firstToken(query) }),
        el('span', { text: ' \u2192 ' }),
        el('strong', { text: name }),
      ],
    });

    host.replaceChildren(
      what,
      // The whole URL, not just the host: the point of the screen is that the
      // user can see the destination before they are on it.
      el('p', { class: 'confirm-url', text: target.href }),
      el('p', {
        class: 'confirm-actions',
        children: [proceed, link(searchUrl(query), 'Search for what you typed instead')],
      }),
    );
    // Focus lands on the button, so the group and its label are what a screen
    // reader reads on arrival: without them the whole page is "Open github.com".
    host.setAttribute('role', 'group');
    host.setAttribute('aria-labelledby', what.id);
    host.hidden = false;
    proceed.focus();
  });
}

function destinationLabel(target: URL): string {
  if (target.protocol === 'chrome-extension:') return 'BunnyLol';
  return target.hostname.replace(/^www\./, '');
}

function fail(query: string, error: unknown): void {
  hideStatus();
  hideConfirm();
  // The error page is the only thing left; render it into the body rather than
  // leave a blank window if `#err` was edited away.
  const box = document.getElementById('err') ?? document.body;

  const title = document.createElement('h1');
  title.className = 'err-title';
  title.textContent = 'BunnyLol could not open that';

  const echo = document.createElement('p');
  echo.className = 'err-echo';
  const code = document.createElement('code');
  code.textContent = query || '(empty query)';
  echo.append('You typed ', code);

  const why = document.createElement('p');
  why.className = 'err-why';
  why.textContent = errorText(error) || 'Unknown error.';

  // The links are spaced by the class's own gap; the separator character this
  // used to append would be a flex item of its own.
  const actions = document.createElement('p');
  actions.className = 'err-actions';
  actions.append(link(searchUrl(query), 'Search for it instead'), link(optionsUrl(), 'BunnyLol settings'));

  box.replaceChildren(title, echo, why, actions);
  box.hidden = false;
  // `#wrap`'s padding went with it in the body fallback.
  if (box === document.body) box.classList.add('err-fallback');
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
    // Not a parseable URL: no better guess than the fallback.
  }
  return fallback;
}

/** Both of the error page's actions and the confirmation's search escape. */
function link(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.className = 'go-link';
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

function hideConfirm(): void {
  const host = document.getElementById('confirm');
  if (host) host.hidden = true;
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
  // the user actually typed, `gh foo&blpass=1` would search for `gh foo`,
  // and the rule layer already guarantees a marked url is never redirected
  // here: fitPlan refuses to register an engine's redirect rules unless
  // Chrome accepted its allow rule too.
  const query = isBouncedUrl(raw) ? stripPassthrough(raw) : raw;
  statusTimer = setTimeout(showStatus, STATUS_DELAY_MS);
  dispatch(query).catch((error) => fail(query, error));
}
