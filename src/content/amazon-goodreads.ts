/**
 * Amazon book pages: a button next to the title that opens the same book on
 * Goodreads. Isolated world, shadow DOM, textContent only. The page is never
 * parsed as HTML we did not write (invariant 11).
 */

import { extractIsbn, goodreadsUrlForIsbn, isAmazonProductPath } from '../lib/amazon-book';

const HOST_ID = 'bunnylol-goodreads';

/**
 * Copied by hand from design/tokens.css, the same way go.html does. This sheet
 * lives in a shadow root on amazon.com, so the extension's tokens.css is not
 * on the page, and Inter is not loaded there either. The sand fill and dark
 * label are the brand pair that already meets contrast on a white Amazon page.
 */
const SHADOW_CSS = `
:host { all: initial; }
.wrap { display: block; margin: 8px 0 12px; }
button {
  font: 600 13px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  background: #e1ab76;
  color: #1a1a1a;
  border: 0;
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
button:hover { background: #d69b5d; }
button:focus-visible { outline: 2px solid #895420; outline-offset: 2px; }
svg { width: 14px; height: 14px; flex: none; }
`;

let mountedFor: string | null = null;
let debounce = 0;
let lastHref = location.href;

function refresh(): void {
  if (location.href !== lastHref) {
    lastHref = location.href;
    unmount();
    mountedFor = null;
  }

  if (!isAmazonProductPath(location.pathname)) {
    unmount();
    mountedFor = null;
    return;
  }

  if (mountedFor && document.getElementById(HOST_ID)) return;

  const isbn = extractIsbn(document.documentElement.innerHTML);
  if (!isbn) {
    unmount();
    mountedFor = null;
    return;
  }

  const url = goodreadsUrlForIsbn(isbn);
  unmount();
  mount(url);
  mountedFor = url;
}

function schedule(): void {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(refresh, 120);
}

function mount(url: string): void {
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = SHADOW_CSS;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'View this book on Goodreads (BunnyLol)');
  button.title = 'Open the Goodreads page for this book';
  button.append(bookIcon(), document.createTextNode('View on Goodreads'));
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    location.assign(url);
  });

  wrap.append(button);
  shadow.append(style, wrap);

  const target = mountPoint();
  if (target) {
    target.insertAdjacentElement('afterend', host);
    return;
  }
  host.style.position = 'fixed';
  host.style.top = '72px';
  host.style.right = '16px';
  host.style.zIndex = '2147483646';
  document.documentElement.append(host);
}

function unmount(): void {
  document.getElementById(HOST_ID)?.remove();
}

function mountPoint(): Element | null {
  return (
    document.querySelector('#productTitle') ??
    document.querySelector('#title') ??
    document.querySelector('#titleSection')
  );
}

function bookIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 2.5h6.5A2.5 2.5 0 0 1 12 5v8.5H5.5A2.5 2.5 0 0 0 3 11V2.5zm0 0V11');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function boot(): void {
  refresh();
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
