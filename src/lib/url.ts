/**
 * The one place extension-relative destinations become navigable URLs.
 *
 * `resolve()` is chrome-free, so meta commands come back as extension-relative
 * paths like `options.html#help`. The omnibox and the dispatch page both have
 * to expand them, and they must agree: hence a shared module rather than a
 * copy in each. (go.ts cannot import this from `background.ts`: that module is
 * the service worker entry point and registering its listeners as a side effect
 * of opening a tab would be wrong.)
 */

/** Anything with a scheme is already navigable; anything else is our own page. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

export function toNavigableUrl(url: string): string {
  const target = (url ?? '').trim();
  if (ABSOLUTE_URL.test(target)) return target;
  // Strip leading slashes so a protocol-relative `//host/x` cannot escape the
  // extension origin; it just resolves to a missing extension resource.
  return chrome.runtime.getURL(target.replace(/^\/+/, ''));
}
