/**
 * `toNavigableUrl` is the single place an extension-relative destination becomes
 * a real URL. go.ts, background.ts and popup.ts all call it, which is the only
 * reason the three surfaces agree on where `bl`, `add …` and `set` go. A copy
 * in any one of them would drift; these tests pin the shared behaviour and,
 * with it, that every meta builtin lands inside our own origin.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toNavigableUrl } from '../src/lib/url';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { mergeCommands, resolve } from '../src/lib/resolve';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS } from '../src/lib/types';

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
  it('leaves anything with a scheme alone', () => {
    expect(toNavigableUrl('https://github.com/')).toBe('https://github.com/');
    expect(toNavigableUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(toNavigableUrl(`${EXT_ORIGIN}/options.html`)).toBe(`${EXT_ORIGIN}/options.html`);
  });

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

  it('sends every meta builtin to a url inside this extension', () => {
    const commands = mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);
    const metas = BUILTIN_COMMANDS.filter((cmd) => cmd.handler === 'meta');
    expect(metas.length).toBeGreaterThan(0);
    for (const cmd of metas) {
      for (const query of [cmd.keys[0], `${cmd.keys[0]} some words`]) {
        const url = toNavigableUrl(resolve(query, commands, DEFAULT_SETTINGS).url);
        expect(url.startsWith(`${EXT_ORIGIN}/`), `${query} -> ${url}`).toBe(true);
      }
    }
  });
});
