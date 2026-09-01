import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, HANDLERS, aiUrl } from '../src/lib/handlers';
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
  'gsite',
  'brightspace',
  'gradescope',
  'youtube',
  'localhost',
  'meta',
  'zoom',
  'meet',
  'tracking',
  'instagram',
  'telegram',
  'whatsapp',
  'ticker',
  'wayback',
  'pkg',
  'word',
  'unindexed',
];

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function cmd(keys: string[], url: string, handler?: HandlerId): Command {
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

const GH = cmd(['gh', 'github'], 'https://github.com/', 'github');

describe('HANDLERS registry', () => {
  it('implements exactly the HandlerId union', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...ALL_HANDLER_IDS].sort());
  });

  it.each(ALL_HANDLER_IDS)('%s returns a non-empty url when bare and with args', (id) => {
    const target = cmd(['k'], 'https://home.test/', id);
    for (const args of ['', 'some args']) {
      const url = HANDLERS[id](args, target, settings());
      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
    }
  });
});

describe('github', () => {
  const github = HANDLERS.github;

  it('opens the command home when bare', () => {
    expect(github('', GH, settings())).toBe('https://github.com/');
  });

  it('routes owner/repo straight to the repo', () => {
    expect(github('facebook/react', GH, settings())).toBe('https://github.com/facebook/react');
    expect(github('/facebook/react/', GH, settings())).toBe('https://github.com/facebook/react');
  });

  it('maps a trailing tab word onto the repo tab', () => {
    expect(github('facebook/react issues', GH, settings())).toBe('https://github.com/facebook/react/issues');
    expect(github('facebook/react pr', GH, settings())).toBe('https://github.com/facebook/react/pulls');
    expect(github('facebook/react PULLS', GH, settings())).toBe('https://github.com/facebook/react/pulls');
    expect(github('facebook/react actions', GH, settings())).toBe('https://github.com/facebook/react/actions');
  });

  it('searches inside the repo when the trailing words are not a tab', () => {
    expect(github('facebook/react use effect', GH, settings())).toBe(
      'https://github.com/facebook/react/search?q=use%20effect',
    );
  });

  it('resolves "me" against settings.githubUser', () => {
    expect(github('me', GH, settings({ githubUser: 'octocat' }))).toBe('https://github.com/octocat');
  });

  it('falls back to a search when "me" has no configured user', () => {
    expect(github('me', GH, settings({ githubUser: '' }))).toBe(
      'https://github.com/search?q=me&type=repositories',
    );
  });

  it('searches repositories for multi-word input', () => {
    expect(github('react server components', GH, settings())).toBe(
      'https://github.com/search?q=react%20server%20components&type=repositories',
    );
  });

  it('unwraps a pasted github.com url', () => {
    expect(github('https://github.com/facebook/react', GH, settings())).toBe('https://github.com/facebook/react');
    expect(github('github.com/facebook/react', GH, settings())).toBe('https://github.com/facebook/react');
    expect(github('https://www.github.com/facebook/react/issues', GH, settings())).toBe(
      'https://github.com/facebook/react/issues',
    );
  });

  it('treats @name as a profile and !text as a forced search', () => {
    expect(github('@octocat', GH, settings())).toBe('https://github.com/octocat');
    expect(github('!facebook/react', GH, settings())).toBe(
      'https://github.com/search?q=facebook%2Freact&type=repositories',
    );
  });

  it('drops traversal segments instead of building a path nobody asked for', () => {
    expect(github('../../etc/passwd', GH, settings())).toBe('https://github.com/etc/passwd');
    expect(github('@../octocat', GH, settings())).toBe('https://github.com/octocat');
    expect(github('..', GH, settings())).toBe('https://github.com/search?q=..&type=repositories');
  });

  it('searches when @name carries trailing words', () => {
    expect(github('@octocat linux', GH, settings())).toBe(
      'https://github.com/search?q=octocat%20linux&type=repositories',
    );
  });

  it('encodes a repo path without mangling the slash', () => {
    expect(github('some owner/repo name', GH, settings())).toBe(
      'https://github.com/search?q=some%20owner%2Frepo%20name&type=repositories',
    );
    expect(github('owner/repo+name', GH, settings())).toBe('https://github.com/owner/repo%2Bname');
  });
});

describe('github sub-handlers', () => {
  it('githubPulls searches pull requests', () => {
    const pr = cmd(['pr'], 'https://github.com/pulls', 'githubPulls');
    expect(HANDLERS.githubPulls('', pr, settings())).toBe('https://github.com/pulls');
    expect(HANDLERS.githubPulls('vitejs/vite', pr, settings())).toBe('https://github.com/pulls?q=vitejs%2Fvite');
  });

  it('githubIssues searches issues', () => {
    const iss = cmd(['iss'], 'https://github.com/issues', 'githubIssues');
    expect(HANDLERS.githubIssues('', iss, settings())).toBe('https://github.com/issues');
    expect(HANDLERS.githubIssues('is:open label:bug', iss, settings())).toBe(
      'https://github.com/issues?q=is%3Aopen%20label%3Abug',
    );
  });

  it('githubGist searches gists', () => {
    const gist = cmd(['gist'], 'https://gist.github.com/', 'githubGist');
    expect(HANDLERS.githubGist('', gist, settings())).toBe('https://gist.github.com/');
    expect(HANDLERS.githubGist('bash prompt', gist, settings())).toBe(
      'https://gist.github.com/search?q=bash%20prompt',
    );
  });
});

describe('reddit', () => {
  const RD = cmd(['rd', 'reddit', 'r'], 'https://www.reddit.com/', 'reddit');
  const reddit = HANDLERS.reddit;

  it('opens the home page when bare', () => {
    expect(reddit('', RD, settings())).toBe('https://www.reddit.com/');
  });

  it('handles an r/ prefixed subreddit', () => {
    expect(reddit('r/purdue', RD, settings())).toBe('https://www.reddit.com/r/purdue/');
    expect(reddit('/r/purdue/', RD, settings())).toBe('https://www.reddit.com/r/purdue/');
  });

  it('treats a bare word as a subreddit', () => {
    expect(reddit('purdue', RD, settings())).toBe('https://www.reddit.com/r/purdue/');
  });

  it('keeps a deeper subreddit path', () => {
    expect(reddit('r/purdue/new', RD, settings())).toBe('https://www.reddit.com/r/purdue/new');
  });

  it('handles user paths and pasted urls', () => {
    expect(reddit('u/spez', RD, settings())).toBe('https://www.reddit.com/user/spez/');
    expect(reddit('https://old.reddit.com/r/purdue', RD, settings())).toBe('https://www.reddit.com/r/purdue/');
  });

  it('searches for anything else', () => {
    expect(reddit('best mechanical keyboard', RD, settings())).toBe(
      'https://www.reddit.com/search/?q=best%20mechanical%20keyboard',
    );
  });
});

describe('npm', () => {
  const NPM = cmd(['npm'], 'https://www.npmjs.com/', 'npm');

  it('jumps to a package page for a valid package name', () => {
    expect(HANDLERS.npm('zod', NPM, settings())).toBe('https://www.npmjs.com/package/zod');
  });

  it('keeps the @ and / of a scoped package readable', () => {
    expect(HANDLERS.npm('@scoped/name', NPM, settings())).toBe('https://www.npmjs.com/package/@scoped/name');
    expect(HANDLERS.npm('@types/node', NPM, settings())).toBe('https://www.npmjs.com/package/@types/node');
  });

  it('searches when the input is not a package name', () => {
    expect(HANDLERS.npm('react router', NPM, settings())).toBe('https://www.npmjs.com/search?q=react%20router');
    expect(HANDLERS.npm('React', NPM, settings())).toBe('https://www.npmjs.com/search?q=React');
  });

  it('opens the home page when bare', () => {
    expect(HANDLERS.npm('', NPM, settings())).toBe('https://www.npmjs.com/');
  });
});

describe('google workspace handlers', () => {
  const GMAIL = cmd(['gmail'], 'https://mail.google.com/mail/u/0/', 'gmail');

  it('gmail keeps a from: operator intact through encoding', () => {
    expect(HANDLERS.gmail('from:advisor has:attachment', GMAIL, settings())).toBe(
      'https://mail.google.com/mail/u/0/#search/from%3Aadvisor%20has%3Aattachment',
    );
  });

  it('gmail opens the inbox when bare and honours the account index', () => {
    expect(HANDLERS.gmail('', GMAIL, settings())).toBe('https://mail.google.com/mail/u/0/');
    expect(HANDLERS.gmail('', GMAIL, settings({ googleAccount: 2 }))).toBe('https://mail.google.com/mail/u/2/');
  });

  it('gdrive searches files or opens my-drive', () => {
    const gd = cmd(['gd'], 'https://drive.google.com/drive/u/0/', 'gdrive');
    expect(HANDLERS.gdrive('', gd, settings())).toBe('https://drive.google.com/drive/u/0/my-drive');
    expect(HANDLERS.gdrive('cs180 syllabus', gd, settings())).toBe(
      'https://drive.google.com/drive/u/0/search?q=cs180%20syllabus',
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

  it('googleApp degrades to a plain drive search for an unknown app url', () => {
    const odd = cmd(['x'], 'https://example.test/', 'googleApp');
    expect(HANDLERS.googleApp('notes', odd, settings())).toBe(
      'https://drive.google.com/drive/u/0/search?q=notes',
    );
  });

  it('gcal searches events or opens the grid', () => {
    const gc = cmd(['gcal'], 'https://calendar.google.com/calendar/u/0/r', 'gcal');
    expect(HANDLERS.gcal('', gc, settings())).toBe('https://calendar.google.com/calendar/u/0/r');
    expect(HANDLERS.gcal('office hours', gc, settings({ googleAccount: 1 }))).toBe(
      'https://calendar.google.com/calendar/u/1/r/search?q=office%20hours',
    );
  });

  it('rejects a nonsense account index', () => {
    expect(HANDLERS.gmail('', GMAIL, settings({ googleAccount: -3 }))).toBe('https://mail.google.com/mail/u/0/');
    expect(HANDLERS.gmail('', GMAIL, settings({ googleAccount: 1.5 }))).toBe('https://mail.google.com/mail/u/0/');
  });
});

describe('microsoft handlers', () => {
  it('outlook searches mail', () => {
    const ol = cmd(['outlook'], 'https://outlook.office.com/mail/', 'outlook');
    expect(HANDLERS.outlook('', ol, settings())).toBe('https://outlook.office.com/mail/');
    expect(HANDLERS.outlook('from:boss', ol, settings())).toBe(
      'https://outlook.office.com/mail/deeplink/search?query=from%3Aboss',
    );
  });

  it('onedrive searches files through the m365 portal', () => {
    const od = cmd(['od'], 'https://m365.cloud.microsoft/onedrive', 'onedrive');
    expect(HANDLERS.onedrive('', od, settings())).toBe('https://m365.cloud.microsoft/onedrive');
    expect(HANDLERS.onedrive('budget', od, settings())).toBe('https://m365.cloud.microsoft/search?q=budget');
  });

  it('teams deep-links a chat only for an address-shaped argument', () => {
    const tm = cmd(['tm'], 'https://teams.microsoft.com/', 'teams');
    expect(HANDLERS.teams('sam@example.com', tm, settings())).toBe(
      'https://teams.microsoft.com/l/chat/0/0?users=sam%40example.com',
    );
    expect(HANDLERS.teams('', tm, settings())).toBe('https://teams.microsoft.com/');
  });

  it('teams keeps non-address arguments searchable instead of dropping them', () => {
    const tm = cmd(['tm'], 'https://teams.microsoft.com/', 'teams');
    expect(HANDLERS.teams('symbol copy paste', tm, settings())).toBe(
      'https://www.google.com/search?q=site%3Amicrosoft.com+symbol%20copy%20paste',
    );
  });
});

describe('purdue handlers', () => {
  it('brightspace deep-links a numeric org unit only', () => {
    const bs = cmd(['bs'], 'https://purdue.brightspace.com/d2l/home', 'brightspace');
    expect(HANDLERS.brightspace('123456', bs, settings())).toBe('https://purdue.brightspace.com/d2l/home/123456');
    expect(HANDLERS.brightspace('', bs, settings())).toBe('https://purdue.brightspace.com/d2l/home');
  });

  it('brightspace sends non-numeric arguments to a purdue.edu search', () => {
    const bs = cmd(['bs'], 'https://purdue.brightspace.com/d2l/home', 'brightspace');
    expect(HANDLERS.brightspace('in nursing programs', bs, settings())).toBe(
      'https://www.google.com/search?q=site%3Apurdue.edu+in%20nursing%20programs',
    );
  });

  it('gradescope deep-links a numeric course only', () => {
    const gs = cmd(['gs'], 'https://www.gradescope.com/', 'gradescope');
    expect(HANDLERS.gradescope('987654', gs, settings())).toBe('https://www.gradescope.com/courses/987654');
    expect(HANDLERS.gradescope('', gs, settings())).toBe('https://www.gradescope.com/');
  });

  it('gradescope sends non-numeric arguments to a gradescope.com search', () => {
    const gs = cmd(['gs'], 'https://www.gradescope.com/', 'gradescope');
    expect(HANDLERS.gradescope('pay scale 2026', gs, settings())).toBe(
      'https://www.google.com/search?q=site%3Agradescope.com+pay%20scale%202026',
    );
  });
});

describe('youtube', () => {
  const YT = cmd(['yt'], 'https://www.youtube.com/', 'youtube');

  it('jumps to a channel handle', () => {
    expect(HANDLERS.youtube('@lofigirl', YT, settings())).toBe('https://www.youtube.com/@lofigirl');
  });

  it('searches otherwise', () => {
    expect(HANDLERS.youtube('lofi beats', YT, settings())).toBe(
      'https://www.youtube.com/results?search_query=lofi%20beats',
    );
    expect(HANDLERS.youtube('', YT, settings())).toBe('https://www.youtube.com/');
  });
});

describe('gsite', () => {
  const SITE = cmd(['gsite', 'site'], 'https://www.google.com/', 'gsite');

  it('builds a site: query from the first word', () => {
    expect(HANDLERS.gsite('react.dev hooks', SITE, settings())).toBe(
      'https://www.google.com/search?q=site%3Areact.dev+hooks',
    );
  });

  it('accepts a pasted origin as the domain', () => {
    expect(HANDLERS.gsite('https://react.dev/ hooks', SITE, settings())).toBe(
      'https://www.google.com/search?q=site%3Areact.dev+hooks',
    );
  });

  it('scopes with no query when only a domain is given', () => {
    expect(HANDLERS.gsite('react.dev', SITE, settings())).toBe('https://www.google.com/search?q=site%3Areact.dev');
  });

  it('opens the command home when bare', () => {
    expect(HANDLERS.gsite('', SITE, settings())).toBe('https://www.google.com/');
  });

  it('encodes the rest of the query with + for spaces', () => {
    expect(HANDLERS.gsite('react.dev use effect & memo', SITE, settings())).toBe(
      'https://www.google.com/search?q=site%3Areact.dev+use+effect+%26+memo',
    );
  });
});

describe('localhost', () => {
  const LH = cmd(['lh', 'localhost'], 'http://localhost:3000', 'localhost');
  const localhost = HANDLERS.localhost;

  it('uses the command default port when bare', () => {
    expect(localhost('', LH, settings())).toBe('http://localhost:3000');
  });

  it('accepts a bare port', () => {
    expect(localhost('8080', LH, settings())).toBe('http://localhost:8080');
  });

  it('accepts a port plus a path, query or hash', () => {
    expect(localhost('8080/api/health', LH, settings())).toBe('http://localhost:8080/api/health');
    expect(localhost('5173/?debug=1', LH, settings())).toBe('http://localhost:5173/?debug=1');
    expect(localhost('4000#top', LH, settings())).toBe('http://localhost:4000#top');
  });

  it('strips a typed localhost prefix', () => {
    expect(localhost('localhost:8080', LH, settings())).toBe('http://localhost:8080');
    expect(localhost('http://localhost:8080/api', LH, settings())).toBe('http://localhost:8080/api');
    expect(localhost('127.0.0.1:9000', LH, settings())).toBe('http://localhost:9000');
  });

  it('treats a rooted path as a path on port 80', () => {
    expect(localhost('/admin/users', LH, settings())).toBe('http://localhost/admin/users');
    expect(localhost('localhost/admin panel', LH, settings())).toBe('http://localhost/admin%20panel');
  });

  it('searches instead of aiming an ordinary query at this machine', () => {
    expect(localhost('surge meaning', LH, settings(), 'lh')).toBe(
      'https://www.google.com/search?q=lh%20surge%20meaning',
    );
    expect(localhost('refused to connect fix', LH, settings(), 'localhost')).toBe(
      'https://www.google.com/search?q=localhost%20refused%20to%20connect%20fix',
    );
    // A bare word is a search too: dev servers live on ports, and
    // `http://localhost/admin` only ever dead-ends on a refused connection.
    expect(localhost('admin', LH, settings(), 'lh')).toBe('https://www.google.com/search?q=lh%20admin');
  });

  it('searches rather than inventing an out-of-range port', () => {
    expect(localhost('99999', LH, settings(), 'lh')).toBe('https://www.google.com/search?q=lh%2099999');
  });

  it('honours a custom default engine when it degrades to a search', () => {
    const kagi = settings({ defaultEngine: 'https://kagi.com/search?q={q}' });
    expect(localhost('surge meaning', LH, kagi, 'lh')).toBe('https://kagi.com/search?q=lh%20surge%20meaning');
  });

  it('drops traversal segments from a path', () => {
    expect(localhost('3000/../admin', LH, settings())).toBe('http://localhost:3000/admin');
  });
});

describe('meta', () => {
  it('opens the relative options route when bare', () => {
    const bl = cmd(['bl'], 'options.html#help', 'meta');
    expect(HANDLERS.meta('', bl, settings())).toBe('options.html#help');
    expect(HANDLERS.meta('', cmd(['bl'], './options.html#help', 'meta'), settings())).toBe('options.html#help');
  });

  it('passes a query to the help route', () => {
    const bl = cmd(['bl'], 'options.html#help', 'meta');
    expect(HANDLERS.meta('git hub', bl, settings())).toBe('options.html#help?q=git%20hub');
  });

  it('leaves out a parameter no options route reads', () => {
    // options.ts reads `q` on #help and `prefill` on #new, and nothing on
    // #settings; `set foo` used to build `#settings?q=foo`, which vanished.
    const set = cmd(['set'], 'options.html#settings', 'meta');
    expect(HANDLERS.meta('foo', set, settings())).toBe('options.html#settings');
  });

  it('prefills the new-shortcut form', () => {
    const add = cmd(['add'], 'options.html#new', 'meta');
    expect(HANDLERS.meta('tix https://x.test/?q={q}', add, settings())).toBe(
      'options.html#new?prefill=tix%20https%3A%2F%2Fx.test%2F%3Fq%3D%7Bq%7D',
    );
  });
});

describe('aiUrl', () => {
  it.each(AI_PROVIDERS.map((p) => [p.id, p.template, p.home] as const))(
    '%s uses its template with a prompt and its home without one',
    (id, template, home) => {
      expect(aiUrl(id, 'hello world', settings())).toBe(template.replace('{q}', 'hello%20world'));
      expect(aiUrl(id, '', settings())).toBe(home);
      expect(aiUrl(id, '   ', settings())).toBe(home);
    },
  );

  it('produces the documented provider urls', () => {
    expect(aiUrl('claude', 'hi', settings())).toBe('https://claude.ai/new?q=hi');
    expect(aiUrl('chatgpt', 'hi', settings())).toBe('https://chatgpt.com/?q=hi');
    // Gemini has no URL prefill, so the prompt goes to Google AI Mode instead.
    expect(aiUrl('gemini', 'hi', settings())).toBe('https://www.google.com/search?udm=50&q=hi');
    expect(aiUrl('claudecode', 'hi', settings())).toBe('https://claude.ai/code?q=hi');
  });

  it('falls back to the first provider for an unknown id', () => {
    expect(aiUrl('nonesuch', 'hi', settings())).toBe(aiUrl(AI_PROVIDERS[0].id, 'hi', settings()));
  });

  it('applies a settings.aiTemplates override', () => {
    const s = settings({ aiTemplates: { chatgpt: 'https://chatgpt.com/?prompt={q}&model=o1' } });
    expect(aiUrl('chatgpt', 'hi there', s)).toBe('https://chatgpt.com/?prompt=hi%20there&model=o1');
  });

  it('ignores an override that would drop the prompt', () => {
    const s = settings({ aiTemplates: { claude: 'https://claude.ai/new' } });
    expect(aiUrl('claude', 'hi', s)).toBe('https://claude.ai/new?q=hi');
  });

  it('encodes a prompt full of url metacharacters', () => {
    expect(aiUrl('claude', 'a&b=c #d', settings())).toBe('https://claude.ai/new?q=a%26b%3Dc%20%23d');
  });
});

describe('ai handler', () => {
  const ai = HANDLERS.ai;
  const aiCmd = (key: string) => cmd([key], 'https://claude.ai/new', 'ai');

  const providerCmd = (key: string, provider: string): Command => ({
    ...cmd([key], 'https://claude.ai/new', 'ai'),
    provider,
  });

  it('dispatches on provider, not on a rebindable key', () => {
    expect(ai('hi', providerCmd('ai', 'chatgpt'), settings())).toBe('https://chatgpt.com/?q=hi');
    // The key says Claude; the provider is what counts.
    expect(ai('hi', providerCmd('c', 'chatgpt'), settings())).toBe('https://chatgpt.com/?q=hi');
  });

  it('accepts a provider id or a legacy alias as the default AI', () => {
    expect(ai('hi', aiCmd('?'), settings({ defaultAi: 'chatgpt' }))).toBe('https://chatgpt.com/?q=hi');
    expect(ai('hi', aiCmd('?'), settings({ defaultAi: 'gpt' }))).toBe('https://chatgpt.com/?q=hi');
  });

  it('dispatches on the command canonical key', () => {
    expect(ai('hi', aiCmd('c'), settings())).toBe('https://claude.ai/new?q=hi');
    expect(ai('hi', aiCmd('gpt'), settings())).toBe('https://chatgpt.com/?q=hi');
    expect(ai('hi', aiCmd('gem'), settings())).toBe('https://www.google.com/search?udm=50&q=hi');
    expect(ai('hi', aiCmd('cc'), settings())).toBe('https://claude.ai/code?q=hi');
  });

  it('sends an empty prompt to the provider home', () => {
    expect(ai('', aiCmd('gpt'), settings())).toBe('https://chatgpt.com/');
  });

  it('routes ? to the configured default AI', () => {
    expect(ai('hi', aiCmd('?'), settings({ defaultAi: 'gpt' }))).toBe('https://chatgpt.com/?q=hi');
    expect(ai('hi', aiCmd('?'), settings({ defaultAi: 'gemini' }))).toBe(
      'https://www.google.com/search?udm=50&q=hi',
    );
  });

  it('does not loop when the default AI points back at ?', () => {
    expect(ai('hi', aiCmd('?'), settings({ defaultAi: '?' }))).toBe('https://claude.ai/new?q=hi');
    expect(ai('hi', aiCmd('?'), settings({ defaultAi: 'nonesuch' }))).toBe('https://claude.ai/new?q=hi');
    expect(ai('hi', aiCmd('?'), settings({ defaultAi: '' }))).toBe('https://claude.ai/new?q=hi');
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
  const MEET = slotCmd('gmeet', 'https://meet.google.com/', 'https://meet.google.com/{q}', 'meet');
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
  const IG = slotCmd('ig', 'https://www.instagram.com/', 'https://www.instagram.com/{q}/', 'instagram');
  const TG = slotCmd('tg', 'https://web.telegram.org/', 'https://t.me/{q}', 'telegram');
  const WA = slotCmd('whatsapp', 'https://web.whatsapp.com/', 'https://wa.me/{q}', 'whatsapp');
  const STOCK = slotCmd('stock', 'https://finance.yahoo.com/', 'https://finance.yahoo.com/quote/{q}', 'ticker');
  const WB = slotCmd('wayback', 'https://web.archive.org/', 'https://web.archive.org/web/2/{q}', 'wayback');
  const BP = slotCmd('bundlephobia', 'https://bundlephobia.com/', 'https://bundlephobia.com/package/{q}', 'pkg');
  const DEF = slotCmd(
    'def',
    'https://www.merriam-webster.com/',
    'https://www.merriam-webster.com/dictionary/{q}',
    'word',
  );

  it('opens the command home when bare', () => {
    for (const target of [ZOOM, MEET, FEDEX, IG, TG, WA, STOCK, WB, BP, DEF]) {
      expect(HANDLERS[target.handler as HandlerId]('', target, settings())).toBe(target.url);
    }
  });

  it('joins a zoom meeting only for a meeting id', () => {
    expect(HANDLERS.zoom('1234567890', ZOOM, settings())).toBe('https://zoom.us/j/1234567890');
    expect(HANDLERS.zoom('123 456 7890', ZOOM, settings())).toBe('https://zoom.us/j/1234567890');
    expect(HANDLERS.zoom('h6 recorder review', ZOOM, settings())).toBe(
      'https://www.google.com/search?q=site%3Azoom.us+h6%20recorder%20review',
    );
  });

  it('joins a meet only for a meeting code', () => {
    expect(HANDLERS.meet('abc-defg-hij', MEET, settings())).toBe('https://meet.google.com/abc-defg-hij');
    expect(HANDLERS.meet('https://meet.google.com/abc-defg-hij', MEET, settings())).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(HANDLERS.meet('notes from standup', MEET, settings(), 'meet')).toBe(
      'https://www.google.com/search?q=meet%20notes%20from%20standup',
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

  it('opens a profile only for a handle', () => {
    expect(HANDLERS.instagram('nasa', IG, settings())).toBe('https://www.instagram.com/nasa/');
    expect(HANDLERS.instagram('@nasa', IG, settings())).toBe('https://www.instagram.com/nasa/');
    expect(HANDLERS.instagram('photos of dogs', IG, settings())).toBe(
      'https://www.google.com/search?q=site%3Ainstagram.com+photos%20of%20dogs',
    );
    expect(HANDLERS.telegram('durov', TG, settings())).toBe('https://t.me/durov');
    expect(HANDLERS.telegram('how to leave a group', TG, settings(), 'tg')).toBe(
      'https://www.google.com/search?q=tg%20how%20to%20leave%20a%20group',
    );
  });

  it('starts a whatsapp chat only for a phone number', () => {
    expect(HANDLERS.whatsapp('+1 (555) 123-4567', WA, settings())).toBe('https://wa.me/15551234567');
    expect(HANDLERS.whatsapp('web login qr code', WA, settings())).toBe(
      'https://www.google.com/search?q=site%3Awhatsapp.com+web%20login%20qr%20code',
    );
  });

  it('quotes only a ticker symbol', () => {
    expect(HANDLERS.ticker('NVDA', STOCK, settings())).toBe('https://finance.yahoo.com/quote/NVDA');
    expect(HANDLERS.ticker('^GSPC', STOCK, settings())).toBe('https://finance.yahoo.com/quote/%5EGSPC');
    expect(HANDLERS.ticker('market today', STOCK, settings())).toBe(
      'https://www.google.com/search?q=site%3Afinance.yahoo.com+market%20today',
    );
  });

  it('archives only something with a host in it', () => {
    expect(HANDLERS.wayback('nytimes.com', WB, settings())).toBe('https://web.archive.org/web/2/nytimes.com');
    expect(HANDLERS.wayback('of our own', WB, settings(), 'archive')).toBe(
      'https://www.google.com/search?q=archive%20of%20our%20own',
    );
  });

  it('opens a package page only for a package name', () => {
    expect(HANDLERS.pkg('lodash', BP, settings())).toBe('https://bundlephobia.com/package/lodash');
    expect(HANDLERS.pkg('@types/node', BP, settings())).toBe('https://bundlephobia.com/package/@types/node');
    expect(HANDLERS.pkg('how big is react', BP, settings(), 'bundlephobia')).toBe(
      'https://www.google.com/search?q=bundlephobia%20how%20big%20is%20react',
    );
  });

  it('looks up only a single headword', () => {
    expect(HANDLERS.word('defenestrate', DEF, settings())).toBe(
      'https://www.merriam-webster.com/dictionary/defenestrate',
    );
    expect(HANDLERS.word('a word for happy', DEF, settings())).toBe(
      'https://www.google.com/search?q=site%3Amerriam-webster.com+a%20word%20for%20happy',
    );
  });

  it('degrades a slot command with no template rather than throwing', () => {
    const bare = cmd(['zoom'], 'https://zoom.us/', 'zoom');
    expect(HANDLERS.zoom('1234567890', bare, settings())).toBe(
      'https://www.google.com/search?q=site%3Azoom.us+1234567890',
    );
  });
});

describe('unindexed', () => {
  const CI = cmd(['ci'], 'https://sswis.mypurdue.purdue.edu/CourseInsights/', 'unindexed');

  it('opens the app when bare', () => {
    expect(HANDLERS.unindexed('', CI, settings())).toBe('https://sswis.mypurdue.purdue.edu/CourseInsights/');
  });

  it('reproduces the whole query, keyword included, when it cannot use the words', () => {
    expect(HANDLERS.unindexed('pay scale 2026', CI, settings(), 'ci')).toBe(
      'https://www.google.com/search?q=ci%20pay%20scale%202026',
    );
  });
});
