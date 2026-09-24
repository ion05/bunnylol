import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { parsePrefill } from '../src/lib/draft';
import { mergeCommands } from '../src/lib/resolve';
import { prefillFor, suggestShortcuts } from '../src/lib/suggest';
import { DEFAULT_OVERRIDES } from '../src/lib/types';
import { validateAlias } from '../src/lib/validate';

const commands = mergeCommands(BUILTIN_COMMANDS, DEFAULT_OVERRIDES);

describe('suggestShortcuts', () => {
  it('ranks sites by visits, typed visits counting triple, one per host', () => {
    const out = suggestShortcuts(
      [
        { url: 'https://pitchfork.com/reviews/1', visitCount: 6, title: 'Issue 1' },
        { url: 'https://pitchfork.com/', visitCount: 10, title: 'Pitchfork – Music reviews' },
        { url: 'https://www.kagi.com/settings', visitCount: 3, typedCount: 5 },
        { url: 'https://rarely.example/', visitCount: 2 },
      ],
      commands,
      [],
    );
    expect(out.map((s) => [s.host, s.url])).toEqual([
      ['kagi.com', 'https://www.kagi.com/'],
      ['pitchfork.com', 'https://pitchfork.com/'],
    ]);
    expect(out[1]!.name).toBe('Pitchfork');
  });

  it('skips what a shortcut already reaches, what was dismissed, and non-sites', () => {
    const pages = [
      'https://github.com/facebook/react',
      'https://www.google.com/search?q=x',
      'https://notion.so/page',
      'http://localhost:3000/',
      'http://192.168.1.1/',
      'chrome://settings/',
    ].map((url) => ({ url, visitCount: 50 }));
    expect(suggestShortcuts(pages, commands, ['notion.so'])).toEqual([]);
  });

  it('falls back to another keyword when the obvious one is taken', () => {
    const [s] = suggestShortcuts(
      [{ url: 'https://gh.example.com/', visitCount: 9 }],
      commands,
      [],
    );
    expect(s!.alias).not.toBe('gh');
    expect(validateAlias(s!.alias).ok).toBe(true);
    expect(commands.some((c) => c.keys.includes(s!.alias))).toBe(false);
  });

  it('opens the New shortcut form with the keyword and the site filled in', () => {
    const [s] = suggestShortcuts([{ url: 'https://pitchfork.com/x', visitCount: 9 }], commands, []);
    const draft = parsePrefill(prefillFor(s!));
    expect(draft.keys).toBe('pitchfork');
    expect(draft.url).toBe('https://pitchfork.com/');
  });
});
