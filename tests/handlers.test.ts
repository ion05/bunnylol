import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { AI_PROVIDERS, CARRIERS, HANDLERS, aiUrl, detectCarrier } from '../src/lib/handlers';
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

  it('treats an Object.prototype key as an ordinary search word', () => {
    // `GITHUB_TABS['constructor']` on a plain object literal is truthy, and
    // `gh facebook/react constructor` interpolated `function Object() { … }`
    // into the path. The tables are null-prototype now, so these fall through
    // to the tab search like any other word.
    expect(github('facebook/react constructor', GH, settings())).toBe(
      'https://github.com/facebook/react/search?q=constructor',
    );
    expect(github('facebook/react __proto__', GH, settings())).toBe(
      'https://github.com/facebook/react/search?q=__proto__',
    );
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
    const bs = builtin('bs');
    expect(HANDLERS.brightspace('123456', bs, settings())).toBe('https://purdue.brightspace.com/d2l/home/123456');
    expect(HANDLERS.brightspace('', bs, settings())).toBe('https://purdue.brightspace.com/d2l/home');
  });

  it('brightspace sends non-numeric arguments to a purdue.edu search', () => {
    expect(HANDLERS.brightspace('in nursing programs', builtin('bs'), settings())).toBe(
      'https://www.google.com/search?q=site%3Apurdue.edu+in%20nursing%20programs',
    );
  });

  it('gradescope deep-links a numeric course only', () => {
    const gs = builtin('gs');
    expect(HANDLERS.gradescope('987654', gs, settings())).toBe('https://www.gradescope.com/courses/987654');
    expect(HANDLERS.gradescope('', gs, settings())).toBe('https://www.gradescope.com/');
  });

  it('gradescope sends non-numeric arguments to a gradescope.com search', () => {
    expect(HANDLERS.gradescope('pay scale 2026', builtin('gs'), settings())).toBe(
      'https://www.google.com/search?q=site%3Agradescope.com+pay%20scale%202026',
    );
  });

  // Brightspace and Gradescope are multi-tenant, so nothing about the school is
  // allowed to live in the handler: a user who repoints the row at their own
  // institution must keep both the deep link and the degrade.
  it('brightspace follows an edited url to another institution', () => {
    const bs: Command = { ...builtin('bs'), url: 'https://iu.brightspace.com/d2l/home', searchUrl: undefined };
    expect(HANDLERS.brightspace('4242', bs, settings())).toBe('https://iu.brightspace.com/d2l/home/4242');
    expect(HANDLERS.brightspace('cs251', bs, settings())).toBe(
      'https://www.google.com/search?q=site%3Abrightspace.com+cs251',
    );
  });

  it('gradescope follows an edited url to another institution', () => {
    const gs: Command = { ...builtin('gs'), url: 'https://gradescope.example.edu/', searchUrl: undefined };
    expect(HANDLERS.gradescope('7', gs, settings())).toBe('https://gradescope.example.edu/courses/7');
    expect(HANDLERS.gradescope('rubric', gs, settings())).toBe(
      'https://www.google.com/search?q=site%3Aexample.edu+rubric',
    );
  });

  it('sends the words to an edited searchUrl rather than a site: search', () => {
    const gs: Command = { ...builtin('gs'), searchUrl: 'https://example.test/find?q={q}' };
    expect(HANDLERS.gradescope('pay scale', gs, settings())).toBe('https://example.test/find?q=pay%20scale');
  });

  it('builds a clean deep link from a url carrying a query or fragment', () => {
    const bs: Command = { ...builtin('bs'), url: 'https://x.test/d2l/home?a=1#z' };
    expect(HANDLERS.brightspace('9', bs, settings())).toBe('https://x.test/d2l/home/9');
  });

  // The deep link hangs off the tenant's ORIGIN, not off whatever path the row
  // happens to carry: a bare origin is the most natural thing to paste, and a
  // row left pointing at a login or dashboard path must not turn the product's
  // own path into `/d2l/login/12345`.
  it('deep-links off the origin whatever path the edited url carries', () => {
    const bare: Command = { ...builtin('bs'), url: 'https://school.brightspace.com' };
    expect(HANDLERS.brightspace('12345', bare, settings())).toBe(
      'https://school.brightspace.com/d2l/home/12345',
    );
    const login: Command = { ...builtin('bs'), url: 'https://school.brightspace.com/d2l/login' };
    expect(HANDLERS.brightspace('12345', login, settings())).toBe(
      'https://school.brightspace.com/d2l/home/12345',
    );
    const account: Command = { ...builtin('gs'), url: 'https://www.gradescope.com/account' };
    expect(HANDLERS.gradescope('7', account, settings())).toBe('https://www.gradescope.com/courses/7');
    const courses: Command = { ...builtin('gs'), url: 'https://www.gradescope.com/courses' };
    expect(HANDLERS.gradescope('7', courses, settings())).toBe('https://www.gradescope.com/courses/7');
  });

  // `validateUrlTemplate` parses with `new URL`, which accepts a special
  // scheme's single slash, and stores the string verbatim, so a url that made
  // it past import has to deep-link, not degrade to the landing page.
  it('deep-links from a url whose scheme carries one slash, as stored', () => {
    const bs: Command = { ...builtin('bs'), url: 'https:/school.brightspace.com/d2l/home' };
    expect(HANDLERS.brightspace('12345', bs, settings())).toBe(
      'https://school.brightspace.com/d2l/home/12345',
    );
    // The degrade reads the same field, so it has to read it the same way: a
    // host matched out of this string is `https:`.
    expect(HANDLERS.brightspace('cs251', { ...bs, searchUrl: undefined }, settings())).toBe(
      'https://www.google.com/search?q=site%3Abrightspace.com+cs251',
    );
  });

  // A port is part of the authority but not part of the site, and `site:` takes
  // a host: a tenant on a non-default port must not degrade to `site:x.test:8443`.
  it('degrades to the host of a url carrying a port, without the port', () => {
    const gs: Command = { ...builtin('gs'), url: 'https://gradescope.test:8443/', searchUrl: undefined };
    expect(HANDLERS.gradescope('7', gs, settings())).toBe('https://gradescope.test:8443/courses/7');
    expect(HANDLERS.gradescope('rubric', gs, settings())).toBe(
      'https://www.google.com/search?q=site%3Agradescope.test+rubric',
    );
  });

  // `expandTemplate` treats a placeholder-less template as a bare destination
  // and appends `?q=`, and `validateUrlTemplate` lets one through, so these
  // handlers must not be the one place that throws the user's endpoint away.
  it('sends the words to a searchUrl that carries no placeholder', () => {
    const bs: Command = { ...builtin('bs'), searchUrl: 'https://x.test/find' };
    expect(HANDLERS.brightspace('foo bar', bs, settings())).toBe('https://x.test/find?q=foo%20bar');
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

  it('dispatches on the command canonical key', () => {
    expect(ai('hi', aiCmd('c'), settings())).toBe('https://claude.ai/new?q=hi');
    expect(ai('hi', aiCmd('gpt'), settings())).toBe('https://chatgpt.com/?q=hi');
    expect(ai('hi', aiCmd('gem'), settings())).toBe('https://www.google.com/search?udm=50&q=hi');
    expect(ai('hi', aiCmd('cc'), settings())).toBe('https://claude.ai/code?q=hi');
  });

  it('sends an empty prompt to the provider home', () => {
    expect(ai('', aiCmd('gpt'), settings())).toBe('https://chatgpt.com/');
  });

  // There is no configured default any more, so a command that names neither a
  // provider nor a known alias has to land somewhere rather than throw
  // (invariant 12). The first shipped provider is that somewhere.
  it('falls back to the first provider when nothing selects one', () => {
    const first = AI_PROVIDERS[0];
    expect(ai('hi', aiCmd('?'), settings())).toBe(first.template.replace('{q}', 'hi'));
    expect(ai('hi', aiCmd('nonesuch'), settings())).toBe(first.template.replace('{q}', 'hi'));
    expect(ai('hi', providerCmd('ai', 'nonesuch'), settings())).toBe(
      first.template.replace('{q}', 'hi'),
    );
    expect(ai('', aiCmd('?'), settings())).toBe(first.home);
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
  const WA = slotCmd('whatsapp', 'https://web.whatsapp.com/', 'https://wa.me/{q}', 'whatsapp');
  const DEF = slotCmd(
    'def',
    'https://www.merriam-webster.com/',
    'https://www.merriam-webster.com/dictionary/{q}',
    'word',
  );

  it('opens the command home when bare', () => {
    for (const target of [ZOOM, MEET, FEDEX, IG, WA, DEF]) {
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

  describe('track: one keyword, the carrier read off the number', () => {
    const TRACK = builtin('track');

    it.each([
      ['1Z999AA10123456784', 'ups', 'https://www.ups.com/track?tracknum=1Z999AA10123456784'],
      [
        '9400111899223197428490',
        'usps',
        'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490',
      ],
      ['92001903432200000000000000', 'usps', 'https://tools.usps.com/go/TrackConfirmAction?tLabels=92001903432200000000000000'],
      ['EC123456789US', 'usps', 'https://tools.usps.com/go/TrackConfirmAction?tLabels=EC123456789US'],
      ['123456789012', 'fedex', 'https://www.fedex.com/wtrk/track/?trknbr=123456789012'],
      ['123456789012345', 'fedex', 'https://www.fedex.com/wtrk/track/?trknbr=123456789012345'],
      ['9612019000000000000000', 'fedex', 'https://www.fedex.com/wtrk/track/?trknbr=9612019000000000000000'],
      ['1234567890', 'dhl', 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=1234567890'],
      ['JD014600006281011111', 'dhl', 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=JD014600006281011111'],
    ])('routes %s to %s', (number, carrier, url) => {
      expect(detectCarrier(number)?.id).toBe(carrier);
      expect(HANDLERS.track(number, TRACK, settings(), 'track')).toBe(url);
    });

    it('accepts the spaces and dashes a label prints, and lowercase', () => {
      expect(HANDLERS.track('1z999aa1 0123 4567-84', TRACK, settings(), 'track')).toBe(
        'https://www.ups.com/track?tracknum=1Z999AA10123456784',
      );
      expect(HANDLERS.track('9400 1118 9922 3197 4284 90', TRACK, settings(), 'track')).toBe(
        'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490',
      );
    });

    it('decides the overlapping 20-digit shape by its first digit', () => {
      expect(detectCarrier('94001118992231974284')?.id).toBe('usps');
      expect(detectCarrier('74001118992231974284')?.id).toBe('fedex');
    });

    it('searches for anything no carrier recognises instead of guessing', () => {
      expect(HANDLERS.track('where is my parcel', TRACK, settings(), 'track')).toBe(
        'https://www.google.com/search?q=track%20where%20is%20my%20parcel',
      );
      expect(HANDLERS.track('12345', TRACK, settings(), 'track')).toBe(
        'https://www.google.com/search?q=track%2012345',
      );
      expect(detectCarrier('hourstodaynearme')).toBeNull();
    });

    it('lands on the bare page with no number', () => {
      expect(HANDLERS.track('', TRACK, settings(), 'track')).toBe(TRACK.url);
    });

    it('routes through the same templates the carrier shortcuts use', () => {
      for (const carrier of CARRIERS) {
        const cmd = BUILTIN_COMMANDS.find((entry) => entry.keys[0] === carrier.id);
        expect(cmd?.searchUrl, carrier.id).toBe(carrier.template);
      }
    });
  });

  it('starts a whatsapp chat only for a phone number', () => {
    expect(HANDLERS.whatsapp('+1 (555) 123-4567', WA, settings())).toBe('https://wa.me/15551234567');
    expect(HANDLERS.whatsapp('web login qr code', WA, settings())).toBe(
      'https://www.google.com/search?q=site%3Awhatsapp.com+web%20login%20qr%20code',
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


describe('github repo sub-commands', () => {
  const GH = {
    keys: ['gh'],
    name: 'GitHub',
    description: '',
    url: 'https://github.com/',
    handler: 'github' as HandlerId,
    category: 'dev' as const,
    builtin: true,
  };
  const gh = (args: string, githubUser = '') =>
    HANDLERS.github(args, GH, { ...DEFAULT_SETTINGS, githubUser });

  it('opens the list for a flag with no number', () => {
    expect(gh('facebook/react pr')).toBe('https://github.com/facebook/react/pulls');
    expect(gh('facebook/react i')).toBe('https://github.com/facebook/react/issues');
    expect(gh('facebook/react issues')).toBe('https://github.com/facebook/react/issues');
  });

  it('opens a numbered item, using the path segment that item actually has', () => {
    // GitHub lists at /pulls but addresses one at /pull/123: the mapping
    // cannot just append the number to the tab.
    expect(gh('facebook/react pr 123')).toBe('https://github.com/facebook/react/pull/123');
    expect(gh('facebook/react i 456')).toBe('https://github.com/facebook/react/issues/456');
    expect(gh('facebook/react pr #123')).toBe('https://github.com/facebook/react/pull/123');
  });

  it('searches within the tab rather than dropping trailing words', () => {
    expect(gh('facebook/react pr auth bug')).toBe(
      'https://github.com/facebook/react/pulls?q=auth%20bug',
    );
    expect(gh('facebook/react i 12 34')).toBe('https://github.com/facebook/react/issues?q=12%2034');
  });

  it('leaves the existing behaviour alone', () => {
    expect(gh('facebook/react')).toBe('https://github.com/facebook/react');
    expect(gh('me', 'octocat')).toBe('https://github.com/octocat');
    expect(gh('')).toBe('https://github.com/');
  });
});

describe('google account index', () => {
  const mk = (keys: string[], url: string, handler: HandlerId) => ({
    keys,
    name: '',
    description: '',
    url,
    handler,
    category: 'google' as const,
    builtin: true,
  });
  const DOCS = mk(['docs'], 'https://docs.google.com/document/u/0/', 'googleApp');
  const MAIL = mk(['gmail'], 'https://mail.google.com/', 'gmail');
  const DRIVE = mk(['gdrive'], 'https://drive.google.com/', 'gdrive');
  const CAL = mk(['gcal'], 'https://calendar.google.com/', 'gcal');

  it('takes a leading number as the account index', () => {
    expect(HANDLERS.googleApp('1', DOCS, DEFAULT_SETTINGS)).toBe(
      'https://docs.google.com/document/u/1/',
    );
    expect(HANDLERS.gmail('2', MAIL, DEFAULT_SETTINGS)).toBe('https://mail.google.com/mail/u/2/');
  });

  it('applies the index to a search too', () => {
    expect(HANDLERS.gmail('1 from:mom', MAIL, DEFAULT_SETTINGS)).toBe(
      'https://mail.google.com/mail/u/1/#search/from%3Amom',
    );
    expect(HANDLERS.gdrive('3 budget', DRIVE, DEFAULT_SETTINGS)).toBe(
      'https://drive.google.com/drive/u/3/search?q=budget',
    );
    expect(HANDLERS.gcal('1 standup', CAL, DEFAULT_SETTINGS)).toBe(
      'https://calendar.google.com/calendar/u/1/r/search?q=standup',
    );
  });

  it('falls back to the configured account when no number leads', () => {
    const settings = { ...DEFAULT_SETTINGS, googleAccount: 2 };
    expect(HANDLERS.gmail('', MAIL, settings)).toBe('https://mail.google.com/mail/u/2/');
    expect(HANDLERS.gmail('from:mom', MAIL, settings)).toBe(
      'https://mail.google.com/mail/u/2/#search/from%3Amom',
    );
  });

  it('only treats a leading bare integer as an index', () => {
    // Three or more digits is a year, not an account: only 1-2 digits are
    // peeled off, so `2024 taxes` searches for the whole phrase.
    expect(HANDLERS.gdrive('2024 taxes', DRIVE, DEFAULT_SETTINGS)).toBe(
      'https://drive.google.com/drive/u/0/search?q=2024%20taxes',
    );
    expect(HANDLERS.gdrive('q1 report', DRIVE, DEFAULT_SETTINGS)).toBe(
      'https://drive.google.com/drive/u/0/search?q=q1%20report',
    );
  });
});
