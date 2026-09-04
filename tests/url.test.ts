/**
 * `toNavigableUrl` is the single place an extension-relative destination becomes
 * a real URL. go.ts, background.ts and popup.ts all call it, which is the only
 * reason the three surfaces agree on where `bl`, `add …` and `set` go. A copy
 * in any one of them would drift; these tests pin the shared behaviour and,
 * with it, that every meta builtin lands inside our own origin.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toNavigableUrl } from '../src/lib/url';

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

declare const globalThis: { chrome?: unknown };

beforeEach(() => {
  globalThis.chrome = {
    runtime: { getURL: (path: string) => `${EXT_ORIGIN}/${path}` },
  };
});

afterEach(() => {
  delete globalThis.chrome;
});

describe('toNavigableUrl', () => {
  it('expands a relative meta destination against the extension origin', () => {
    expect(toNavigableUrl('options.html')).toBe(`${EXT_ORIGIN}/options.html`);
    expect(toNavigableUrl('options.html#help')).toBe(`${EXT_ORIGIN}/options.html#help`);
    expect(toNavigableUrl('options.html#new?prefill=a%20b')).toBe(
      `${EXT_ORIGIN}/options.html#new?prefill=a%20b`,
    );
  });

  it('cannot be talked into leaving the extension origin', () => {
    // A protocol-relative path would otherwise resolve to an outside host.
    expect(toNavigableUrl('//evil.test/x')).toBe(`${EXT_ORIGIN}/evil.test/x`);
    expect(toNavigableUrl('/options.html')).toBe(`${EXT_ORIGIN}/options.html`);
    expect(toNavigableUrl('   options.html   ')).toBe(`${EXT_ORIGIN}/options.html`);
  });
});
