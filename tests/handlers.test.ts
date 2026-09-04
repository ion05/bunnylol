import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { HANDLERS, aiUrl, detectCarrier } from '../src/lib/handlers';
import { DEFAULT_SETTINGS } from '../src/lib/types';
import type { Command, HandlerId, Settings } from '../src/lib/types';

const ALL_HANDLER_IDS: HandlerId[] = [
  'github',
  'githubPulls',
  'githubIssues',
  'githubGist',
  'reddit',
  'npm',
  'gmail',
  'gdrive',
  'gcal',
  'googleApp',
  'outlook',
  'onedrive',
  'teams',
  'ai',
  'brightspace',
  'gradescope',
  'youtube',
  'meta',
  'zoom',
  'meet',
  'tracking',
  'track',
  'instagram',
  'whatsapp',
  'word',
];

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

// A non-empty tuple, so the lead alias that names the command is present by the
// type rather than by every call site happening to pass one.
function cmd(keys: [string, ...string[]], url: string, handler?: HandlerId): Command {
  return {
    keys,
    name: keys[0],
    description: '',
    url,
    handler,
    category: 'custom',
    builtin: false,
  };
}

/**
 * The shipped row, not a lookalike. These handlers now read `url` and
 * `searchUrl` off the command, so a hand-built fixture can agree with the
 * handler while the registry it is meant to stand for does not.
 */
function builtin(key: string): Command {
  const found = BUILTIN_COMMANDS.find((command) => command.keys.includes(key));
  if (!found) throw new Error(`no builtin ${key}`);
  return found;
}

const GH = cmd(['gh', 'github'], 'https://github.com/', 'github');

describe('HANDLERS registry', () => {
  it('implements exactly the HandlerId union', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...ALL_HANDLER_IDS].sort());
  });

  it('answers every handler with a non-empty url, bare and with args', () => {
    for (const id of ALL_HANDLER_IDS) {
      const target = cmd(['k'], 'https://home.test/', id);
      for (const args of ['', 'some args']) {
        const url = HANDLERS[id](args, target, settings());
        expect(typeof url, id).toBe('string');
        expect(url.length, id).toBeGreaterThan(0);
      }
    }
  });
});

describe('github', () => {
  const github = HANDLERS.github;

  it('routes owner/repo straight to the repo', () => {
    expect(github('facebook/react', GH, settings())).toBe('https://github.com/facebook/react');
    expect(github('/facebook/react/', GH, settings())).toBe('https://github.com/facebook/react');
  });

  it('searches inside the repo when the trailing words are not a tab', () => {
    expect(github('facebook/react use effect', GH, settings())).toBe(
      'https://github.com/facebook/react/search?q=use%20effect',
    );
  });
});

describe('github sub-handlers', () => {
  it('githubPulls searches pull requests', () => {
    const pr = cmd(['pr'], 'https://github.com/pulls', 'githubPulls');
    expect(HANDLERS.githubPulls('', pr, settings())).toBe('https://github.com/pulls');
    expect(HANDLERS.githubPulls('vitejs/vite', pr, settings())).toBe(
      'https://github.com/pulls?q=vitejs%2Fvite',
    );
  });
});

describe('reddit', () => {
  const RD = cmd(['rd', 'reddit', 'r'], 'https://www.reddit.com/', 'reddit');
  const reddit = HANDLERS.reddit;

  it('handles an r/ prefixed subreddit', () => {
    expect(reddit('r/purdue', RD, settings())).toBe('https://www.reddit.com/r/purdue/');
    expect(reddit('/r/purdue/', RD, settings())).toBe('https://www.reddit.com/r/purdue/');
  });
});

describe('npm', () => {
  const NPM = cmd(['npm'], 'https://www.npmjs.com/', 'npm');

  it('jumps to a package page for a valid package name', () => {
    expect(HANDLERS.npm('zod', NPM, settings())).toBe('https://www.npmjs.com/package/zod');
  });
});

describe('google workspace handlers', () => {
  const GMAIL = cmd(['gmail'], 'https://mail.google.com/mail/u/0/', 'gmail');

  it('gmail keeps a from: operator intact through encoding', () => {
    expect(HANDLERS.gmail('from:advisor has:attachment', GMAIL, settings())).toBe(
      'https://mail.google.com/mail/u/0/#search/from%3Aadvisor%20has%3Aattachment',
    );
  });

  it('googleApp follows the account index for the docs family', () => {
    const doc = cmd(['doc'], 'https://docs.google.com/document/u/0/', 'googleApp');
    const sheet = cmd(['sheet'], 'https://docs.google.com/spreadsheets/u/0/', 'googleApp');
    expect(HANDLERS.googleApp('', doc, settings({ googleAccount: 3 }))).toBe(
      'https://docs.google.com/document/u/3/',
    );
    expect(HANDLERS.googleApp('lab report', doc, settings({ googleAccount: 1 }))).toBe(
      'https://drive.google.com/drive/u/1/search?q=type:document%20lab%20report',
    );
    expect(HANDLERS.googleApp('budget', sheet, settings())).toBe(
      'https://drive.google.com/drive/u/0/search?q=type:spreadsheet%20budget',
    );
  });
});

describe('microsoft handlers', () => {
  it('teams deep-links a chat only for an address-shaped argument', () => {
    const tm = cmd(['tm'], 'https://teams.microsoft.com/', 'teams');
    expect(HANDLERS.teams('sam@example.com', tm, settings())).toBe(
      'https://teams.microsoft.com/l/chat/0/0?users=sam%40example.com',
    );
    expect(HANDLERS.teams('', tm, settings())).toBe('https://teams.microsoft.com/');
  });
});

describe('purdue handlers', () => {
  it('brightspace deep-links a numeric org unit only', () => {
    const bs = builtin('bs');
    expect(HANDLERS.brightspace('123456', bs, settings())).toBe(
      'https://purdue.brightspace.com/d2l/home/123456',
    );
    expect(HANDLERS.brightspace('', bs, settings())).toBe(
      'https://purdue.brightspace.com/d2l/home',
    );
  });
});

describe('youtube', () => {
  const YT = cmd(['yt'], 'https://www.youtube.com/', 'youtube');

  it('jumps to a channel handle', () => {
    expect(HANDLERS.youtube('@lofigirl', YT, settings())).toBe('https://www.youtube.com/@lofigirl');
  });
});

describe('meta', () => {
  it('opens the relative options route when bare', () => {
    const bl = cmd(['bl'], 'options.html#help', 'meta');
    expect(HANDLERS.meta('', bl, settings())).toBe('options.html#help');
    expect(HANDLERS.meta('', cmd(['bl'], './options.html#help', 'meta'), settings())).toBe(
      'options.html#help',
    );
  });
});

describe('aiUrl', () => {
  it('produces the documented provider urls', () => {
    expect(aiUrl('claude', 'hi', settings())).toBe('https://claude.ai/new?q=hi');
    expect(aiUrl('chatgpt', 'hi', settings())).toBe('https://chatgpt.com/?q=hi');
    // Gemini has no URL prefill, so the prompt goes to Google AI Mode instead.
    expect(aiUrl('gemini', 'hi', settings())).toBe('https://www.google.com/search?udm=50&q=hi');
    expect(aiUrl('claudecode', 'hi', settings())).toBe('https://claude.ai/code?q=hi');
  });
});

describe('ai handler', () => {
  const ai = HANDLERS.ai;

  const providerCmd = (key: string, provider: string): Command => ({
    ...cmd([key], 'https://claude.ai/new', 'ai'),
    provider,
  });

  it('dispatches on provider, not on a rebindable key', () => {
    expect(ai('hi', providerCmd('ai', 'chatgpt'), settings())).toBe('https://chatgpt.com/?q=hi');
    // The key says Claude; the provider is what counts.
    expect(ai('hi', providerCmd('c', 'chatgpt'), settings())).toBe('https://chatgpt.com/?q=hi');
  });
});

/**
 * The shape-guarded slots. Each of these commands interpolates its argument
 * into a path segment or an id parameter, so the guard in front of the slot is
 * the whole point: free text must never reach the template, and must never be
 * dropped either.
 */
describe('shape-guarded slots', () => {
  const slotCmd = (key: string, url: string, searchUrl: string, handler: HandlerId): Command => ({
    ...cmd([key], url, handler),
    searchUrl,
  });

  const ZOOM = slotCmd('zoom', 'https://zoom.us/', 'https://zoom.us/j/{q}', 'zoom');
  const FEDEX = slotCmd(
    'fedex',
    'https://www.fedex.com/wtrk/track/',
    'https://www.fedex.com/wtrk/track/?trknbr={q}',
    'tracking',
  );
  const USPS = slotCmd(
    'usps',
    'https://tools.usps.com/go/TrackConfirmAction',
    'https://tools.usps.com/go/TrackConfirmAction?tLabels={q}',
    'tracking',
  );

  it('joins a zoom meeting only for a meeting id', () => {
    expect(HANDLERS.zoom('1234567890', ZOOM, settings())).toBe('https://zoom.us/j/1234567890');
    expect(HANDLERS.zoom('123 456 7890', ZOOM, settings())).toBe('https://zoom.us/j/1234567890');
    expect(HANDLERS.zoom('h6 recorder review', ZOOM, settings())).toBe(
      'https://www.google.com/search?q=site%3Azoom.us+h6%20recorder%20review',
    );
  });

  it('tracks only a tracking-number-shaped argument', () => {
    expect(HANDLERS.tracking('123456789012', FEDEX, settings())).toBe(
      'https://www.fedex.com/wtrk/track/?trknbr=123456789012',
    );
    expect(HANDLERS.tracking('9400111899223197428490', USPS, settings())).toBe(
      'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490',
    );
    expect(HANDLERS.tracking('near me open now', FEDEX, settings())).toBe(
      'https://www.google.com/search?q=site%3Afedex.com+near%20me%20open%20now',
    );
    // A long run of letters is not a tracking number: they all carry digits.
    expect(HANDLERS.tracking('hourstodaynearme', USPS, settings())).toBe(
      'https://www.google.com/search?q=site%3Ausps.com+hourstodaynearme',
    );
  });

  describe('track: one keyword, the carrier read off the number', () => {
    const TRACK = builtin('track');

    it('reads the carrier off the number', () => {
      const cases: Array<[string, string, string]> = [
        ['1Z999AA10123456784', 'ups', 'https://www.ups.com/track?tracknum=1Z999AA10123456784'],
        [
          '9400111899223197428490',
          'usps',
          'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490',
        ],
        ['123456789012', 'fedex', 'https://www.fedex.com/wtrk/track/?trknbr=123456789012'],
        [
          'JD014600006281011111',
          'dhl',
          'https://www.dhl.com/global-en/home/tracking.html?tracking-id=JD014600006281011111',
        ],
      ];
      for (const [number, carrier, url] of cases) {
        expect(detectCarrier(number)?.id, number).toBe(carrier);
        expect(HANDLERS.track(number, TRACK, settings(), 'track'), number).toBe(url);
      }
    });
  });
});
