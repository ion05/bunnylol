/**
 * Smart argument handlers: pure, synchronous `(args, cmd, settings) => url`.
 *
 * Nothing in here touches `chrome.*`, the DOM, or async work, and no handler
 * may throw — odd input degrades to a sensible URL so the resolver always has
 * somewhere to navigate.
 */

import type { AiProvider, Command, HandlerFn, HandlerId, Settings } from './types';
import { DEFAULT_SETTINGS } from './types';

/**
 * The `?q=` prefill params below are undocumented and providers change them
 * without notice (Claude's has already come and gone once). They are all kept
 * in this one map, and `settings.aiTemplates[id]` overrides any of them, so a
 * break is fixable from the options page without a rebuild.
 *
 * Gemini is the exception: gemini.google.com has never accepted a prompt from
 * the URL and silently drops one, so the Gemini entry routes to Google's AI
 * Mode (`udm=50`), which is the same model and does answer from the query
 * string. A bare `gem` still opens the Gemini app itself.
 */
export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'claude',
    label: 'Claude',
    template: 'https://claude.ai/new?q={q}',
    home: 'https://claude.ai/',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    template: 'https://chatgpt.com/?q={q}',
    home: 'https://chatgpt.com/',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    template: 'https://www.google.com/search?udm=50&q={q}',
    home: 'https://gemini.google.com/app',
  },
  {
    id: 'claudecode',
    label: 'Claude Code',
    template: 'https://claude.ai/code?q={q}',
    home: 'https://claude.ai/code',
  },
];

/**
 * Fallback dispatch for AI commands with no `provider`: imported or
 * hand-written commands that name the `ai` handler but predate that field.
 * Builtins carry `provider` and never consult this.
 */
const AI_KEYS: Record<string, string> = {
  c: 'claude',
  cl: 'claude',
  claude: 'claude',
  gpt: 'chatgpt',
  chatgpt: 'chatgpt',
  gem: 'gemini',
  gemini: 'gemini',
  cc: 'claudecode',
  claudecode: 'claudecode',
};

/** Unpaired surrogates, which `encodeURIComponent` throws on. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `encodeURIComponent` that cannot throw. A query pasted out of a broken editor
 * can carry an unpaired surrogate; substituting U+FFFD keeps the user moving
 * instead of stranding them, and matches what every browser renders anyway.
 */
export function encodeQuery(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATE, '\uFFFD'));
}

/**
 * Percent-encodes a run of path segments, but leaves `/` and `@` readable —
 * both are legal in a path, and `@scope/pkg` URLs are unreadable without them.
 */
export function encodePath(value: string): string {
  return dropDotSegments(encodeQuery(value).replace(/%2F/gi, '/').replace(/%40/gi, '@'));
}

/**
 * Removes `.` and `..` segments. They are legal characters, but a handler that
 * interpolates them builds a URL nobody asked for — `gh ../../etc/passwd` is a
 * request for a repo, not for `github.com/etc/passwd` — so they never reach a
 * path we construct. Empty segments survive, so a leading or interior `/` is
 * preserved for callers that depend on it.
 */
function dropDotSegments(value: string): string {
  return value
    .split('/')
    .filter((segment) => segment !== '.' && segment !== '..')
    .join('/');
}

function enc(value: string): string {
  return encodeQuery(value);
}

function trimSlashes(value: string): string {
  return dropDotSegments(value.replace(/^\/+|\/+$/g, ''));
}

/**
 * Substitutes `args` into a URL template.
 *
 * `{q}` is the canonical placeholder; `%s` is accepted for templates copied out
 * of Chrome's custom-search-engine UI. When the template has neither and there
 * are arguments to place, we treat the template as a bare destination and append
 * them as `q` — `?q=` when the template has no query string yet, `&q=` when it
 * already does — because that is what every engine we ship reads. A template
 * with a fragment should spell out `{q}`: the append lands after the `#`.
 *
 * It lives here rather than in `resolve.ts` because the handlers need it too and
 * `handlers.ts` is the module that owns the encoder; `resolve.ts` re-exports it.
 */
export function expandTemplate(template: string, args: string): string {
  const encoded = encodeQuery(args);
  if (template.includes('{q}') || template.includes('%s')) {
    // split/join rather than replace(), so `$&`-style sequences that survive
    // encoding are never treated as replacement patterns.
    return template.split('{q}').join(encoded).split('%s').join(encoded);
  }
  if (!args) return template;
  return `${template}${template.includes('?') ? '&' : '?'}q=${encoded}`;
}

/**
 * The `site:` degrade, matching `siteSearch` in `commands.ts`: when a command
 * cannot use the words for anything better, they stay searchable instead of
 * being dropped or jammed into a slot that expects an id.
 */
function googleSite(host: string, query: string): string {
  return `https://www.google.com/search?q=site%3A${host}+${enc(query)}`;
}

/**
 * The registrable domain behind a command's own url, so `tools.usps.com`
 * degrades to a search of `usps.com`. Every command that uses this ships a
 * plain two-label domain.
 */
function commandHost(url: string): string {
  const host = /^(?:https?:\/\/)?([^/?#]+)/i.exec((url ?? '').trim())?.[1]?.toLowerCase() ?? '';
  const labels = host.split('.');
  return labels.length > 2 ? labels.slice(-2).join('.') : host;
}

/**
 * A plain default-engine search for exactly what the user typed, keyword and
 * all. This is the degrade for a command whose own site publishes nothing a
 * search could match: reproducing the query the alias intercepted beats opening
 * an app that cannot answer it.
 */
function plainSearch(keyword: string, args: string, settings: Settings): string {
  const engine = (settings?.defaultEngine ?? '').trim() || DEFAULT_SETTINGS.defaultEngine;
  const query = [(keyword ?? '').trim(), args.trim()].filter(Boolean).join(' ');
  return expandTemplate(engine, query);
}

function findProvider(providerId: string): AiProvider {
  const id = String(providerId ?? '').trim().toLowerCase();
  const found = AI_PROVIDERS.find((provider) => provider.id === id);
  return found ?? AI_PROVIDERS[0];
}

export function aiUrl(providerId: string, prompt: string, settings: Settings): string {
  const provider = findProvider(providerId);
  const prompted = String(prompt ?? '').trim();
  if (!prompted) return provider.home;

  const override = settings?.aiTemplates?.[provider.id];
  // A user override that lost its {q} would silently drop the prompt, so the
  // builtin template wins in that case.
  const template =
    typeof override === 'string' && override.includes('{q}') ? override.trim() : provider.template;
  return template.replace(/\{q\}/g, enc(prompted));
}

const GITHUB_HOME = 'https://github.com/';

/**
 * Tabs that also address a single numbered item. GitHub's list path and its
 * item path differ for pull requests — `/pulls` but `/pull/123` — so the
 * mapping cannot just append the number to the tab.
 */
const GITHUB_NUMBERED: Record<string, string> = {
  pulls: 'pull',
  issues: 'issues',
};

const GITHUB_TABS: Record<string, string> = {
  issues: 'issues',
  issue: 'issues',
  i: 'issues',
  pulls: 'pulls',
  pull: 'pulls',
  prs: 'pulls',
  pr: 'pulls',
  actions: 'actions',
  releases: 'releases',
  release: 'releases',
  wiki: 'wiki',
  settings: 'settings',
  branches: 'branches',
  commits: 'commits',
  tags: 'tags',
};

function stripGithubHost(value: string): string {
  return value.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com(?:\/|$)/i, '');
}

function githubSearch(query: string): string {
  return `https://github.com/search?q=${enc(query)}&type=repositories`;
}

function github(args: string, cmd: Command, settings: Settings): string {
  const raw = args.trim();
  if (!raw) return cmd.url || GITHUB_HOME;

  if (raw.startsWith('!')) {
    const forced = raw.slice(1).trim();
    return forced ? githubSearch(forced) : cmd.url || GITHUB_HOME;
  }

  if (raw.startsWith('@')) {
    const tokens = raw.slice(1).split(/\s+/).filter(Boolean);
    const user = trimSlashes(tokens[0] ?? '');
    // `@octocat linux` is a search: routing to the profile would throw the rest
    // of the words away.
    if (user && tokens.length === 1) return `${GITHUB_HOME}${encodePath(user)}`;
    return tokens.length > 0 ? githubSearch(tokens.join(' ')) : cmd.url || GITHUB_HOME;
  }

  const tokens = stripGithubHost(raw).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return cmd.url || GITHUB_HOME;

  const head = tokens[0];
  const rest = tokens.slice(1).join(' ');

  if (!rest && head.toLowerCase() === 'me') {
    const user = (settings.githubUser || '').trim();
    if (user) return `${GITHUB_HOME}${encodePath(trimSlashes(user))}`;
    return githubSearch(raw);
  }

  if (head.includes('/')) {
    const path = trimSlashes(head);
    if (!path) return cmd.url || GITHUB_HOME;
    const repo = `${GITHUB_HOME}${encodePath(path)}`;
    if (!rest) return repo;

    const [flag, ...tail] = rest.split(/\s+/);
    const tab = GITHUB_TABS[flag.toLowerCase()];
    if (tab) {
      if (tail.length === 0) return `${repo}/${tab}`;
      const item = GITHUB_NUMBERED[tab];
      // `gh facebook/react pr 123` -> that pull request; `#123` too, since that
      // is how the number is written everywhere else.
      if (item && tail.length === 1 && /^#?\d+$/.test(tail[0])) {
        return `${repo}/${item}/${tail[0].replace('#', '')}`;
      }
      // Words after the flag search within that tab rather than being dropped.
      return `${repo}/${tab}?q=${enc(tail.join(' '))}`;
    }
    return `${repo}/search?q=${enc(rest)}`;
  }

  return githubSearch(raw);
}

function githubPulls(args: string, cmd: Command, _settings: Settings): string {
  const query = args.trim();
  const home = cmd.url || 'https://github.com/pulls';
  return query ? `https://github.com/pulls?q=${enc(query)}` : home;
}

function githubIssues(args: string, cmd: Command, _settings: Settings): string {
  const query = args.trim();
  const home = cmd.url || 'https://github.com/issues';
  return query ? `https://github.com/issues?q=${enc(query)}` : home;
}

function githubGist(args: string, cmd: Command, _settings: Settings): string {
  const query = args.trim();
  const home = cmd.url || 'https://gist.github.com/';
  return query ? `https://gist.github.com/search?q=${enc(query)}` : home;
}

const REDDIT_HOME = 'https://www.reddit.com/';

function reddit(args: string, cmd: Command, _settings: Settings): string {
  const raw = args.trim();
  if (!raw) return cmd.url || REDDIT_HOME;

  const path = raw.replace(/^(?:https?:\/\/)?(?:www\.|old\.|new\.)?reddit\.com(?:\/|$)/i, '');
  if (!path) return cmd.url || REDDIT_HOME;

  const user = /^\/?u(?:ser)?\/([A-Za-z0-9_-]{1,20})\/?$/.exec(path);
  if (user) return `${REDDIT_HOME}user/${encodePath(user[1])}/`;

  const sub = /^\/?r\/([A-Za-z0-9_]{2,21})((?:\/[A-Za-z0-9_-]+)*)\/?$/.exec(path);
  if (sub) return `${REDDIT_HOME}r/${encodePath(sub[1])}${sub[2] ? encodePath(sub[2]) : '/'}`;

  if (/^[A-Za-z0-9_]{2,21}$/.test(path)) return `${REDDIT_HOME}r/${encodePath(path)}/`;

  return `${REDDIT_HOME}search/?q=${enc(raw)}`;
}

/** npm's own package-name rule, minus the length cap. */
const NPM_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function npm(args: string, cmd: Command, _settings: Settings): string {
  const raw = args.trim();
  if (!raw) return cmd.url || 'https://www.npmjs.com/';
  if (NPM_NAME.test(raw)) return `https://www.npmjs.com/package/${encodePath(raw)}`;
  return `https://www.npmjs.com/search?q=${enc(raw)}`;
}

/** The `/u/N/` segment shared by the Google Workspace apps. */
function googleAccount(settings: Settings): string {
  const index = Number(settings?.googleAccount);
  return Number.isInteger(index) && index >= 0 && index < 100 ? String(index) : '0';
}

/**
 * Peels a leading account index off the arguments: `docs 1` opens account 1,
 * `gmail 1 from:mom` searches account 1, and no leading number falls back to
 * `settings.googleAccount`. The trade-off is that a bare `gmail 1` selects an
 * account rather than searching for "1", which is the useful reading far more
 * often.
 */
function splitGoogleAccount(args: string, settings: Settings): { account: string; query: string } {
  const raw = args.trim();
  const match = /^(\d{1,2})(?:\s+([\s\S]*))?$/.exec(raw);
  if (match) return { account: match[1], query: (match[2] ?? '').trim() };
  return { account: googleAccount(settings), query: raw };
}

function gmail(args: string, _cmd: Command, settings: Settings): string {
  const { account, query } = splitGoogleAccount(args, settings);
  const base = `https://mail.google.com/mail/u/${account}/`;
  // Operators like `from:mom` have to survive the round trip, so the whole
  // query is percent-encoded rather than split on spaces.
  return query ? `${base}#search/${enc(query)}` : base;
}

function gdrive(args: string, _cmd: Command, settings: Settings): string {
  const { account, query } = splitGoogleAccount(args, settings);
  const base = `https://drive.google.com/drive/u/${account}/`;
  return query ? `${base}search?q=${enc(query)}` : `${base}my-drive`;
}

/**
 * Drive's `type:` filter for each Docs-family editor, keyed by the path segment
 * of the app's own URL — the commands stay plain data and the account index
 * lives in one place.
 */
const GOOGLE_APP_TYPES: Record<string, string> = {
  document: 'document',
  spreadsheets: 'spreadsheet',
  presentation: 'presentation',
  forms: 'form',
};

function googleApp(args: string, cmd: Command, settings: Settings): string {
  const { account, query } = splitGoogleAccount(args, settings);
  const url = cmd.url || 'https://docs.google.com/document/u/0/';
  const home = url.replace(/\/u\/\d+(?=\/|$)/, `/u/${account}`);
  if (!query) return home;

  const app = /docs\.google\.com\/([a-z]+)/i.exec(url)?.[1]?.toLowerCase() ?? '';
  const type = GOOGLE_APP_TYPES[app];
  const search = `https://drive.google.com/drive/u/${account}/search?q=`;
  return type ? `${search}type:${type}%20${enc(query)}` : `${search}${enc(query)}`;
}

function gcal(args: string, _cmd: Command, settings: Settings): string {
  const { account, query } = splitGoogleAccount(args, settings);
  const base = `https://calendar.google.com/calendar/u/${account}/r`;
  return query ? `${base}/search?q=${enc(query)}` : base;
}

function outlook(args: string, cmd: Command, _settings: Settings): string {
  const query = args.trim();
  const home = cmd.url || 'https://outlook.office.com/mail/';
  // `deeplink/search?query=` is the widely documented OWA search form, but it is
  // UNVERIFIED against a live mailbox: outlook.office.com answers 417 to every
  // unauthenticated request under /mail/, so it cannot be probed from outside.
  return query ? `https://outlook.office.com/mail/deeplink/search?query=${enc(query)}` : home;
}

function onedrive(args: string, cmd: Command, _settings: Settings): string {
  const query = args.trim();
  // onedrive.live.com is the personal-account surface; a work or school
  // account's files live in a SharePoint tenant reached through M365 search.
  const home = cmd.url || 'https://m365.cloud.microsoft/onedrive';
  return query ? `https://m365.cloud.microsoft/search?q=${enc(query)}` : home;
}

const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function teams(args: string, cmd: Command, _settings: Settings): string {
  const query = args.trim();
  const home = cmd.url || 'https://teams.microsoft.com/';
  if (!query) return home;
  // The only Teams deep link Microsoft actually documents is "start a chat";
  // free text has no supported search route, so a guessed URL would 404.
  if (EMAILISH.test(query)) return `https://teams.microsoft.com/l/chat/0/0?users=${enc(query)}`;
  // Teams itself is a login-walled SPA with nothing indexed, but everything
  // written about it lives across support. and learn.microsoft.com, so the
  // words stay searchable there rather than being dropped.
  return googleSite('microsoft.com', query);
}

function brightspace(args: string, cmd: Command, _settings: Settings): string {
  const query = args.trim();
  const home = cmd.url || 'https://purdue.brightspace.com/d2l/home';
  if (!query) return home;
  // D2L's only stable deep link is the per-course home keyed by org unit id.
  if (/^\d+$/.test(query)) return `https://purdue.brightspace.com/d2l/home/${query}`;
  // The D2L host is login-walled, but Purdue's course and Brightspace pages on
  // purdue.edu are indexed — the same fallback `boilerconnect` already uses.
  return googleSite('purdue.edu', query);
}

function gradescope(args: string, cmd: Command, _settings: Settings): string {
  const query = args.trim();
  const home = cmd.url || 'https://www.gradescope.com/';
  if (!query) return home;
  // Courses are keyed by numeric id; nothing else is a deep link.
  if (/^\d+$/.test(query)) return `https://www.gradescope.com/courses/${query}`;
  return googleSite('gradescope.com', query);
}

/** A channel handle: one token, no spaces. `@lofi girl` is a search. */
const YOUTUBE_HANDLE = /^[A-Za-z0-9._-]{1,30}$/;

function youtube(args: string, cmd: Command, _settings: Settings): string {
  const raw = args.trim();
  if (!raw) return cmd.url || 'https://www.youtube.com/';
  if (raw.startsWith('@')) {
    const handle = trimSlashes(raw.slice(1));
    if (YOUTUBE_HANDLE.test(handle)) return `https://www.youtube.com/@${encodePath(handle)}`;
  }
  return `https://www.youtube.com/results?search_query=${enc(raw)}`;
}

/** A provider id, an alias from `AI_KEYS`, or '' when neither resolves. */
function resolveProvider(value: string): string {
  const id = value.trim().toLowerCase();
  if (!id) return '';
  if (AI_PROVIDERS.some((provider) => provider.id === id)) return id;
  return AI_KEYS[id] ?? '';
}

function ai(args: string, cmd: Command, settings: Settings): string {
  // Dispatch on `provider`, not on `keys[0]`: the user can rebind a builtin's
  // aliases, and binding ChatGPT to `ai` must not start sending prompts to
  // whatever the old key happened to map to.
  const key = (cmd.keys?.[0] ?? '').trim().toLowerCase();
  let providerId = resolveProvider(cmd.provider ?? '') || AI_KEYS[key] || '';
  if (!providerId) {
    // `?` (and any other command with no provider of its own) defers to the
    // configured default, guarding against a default that points back here.
    const target = (settings?.defaultAi ?? '').trim().toLowerCase();
    providerId = (target && target !== key ? resolveProvider(target) : '') || 'claude';
  }
  return aiUrl(providerId, args, settings);
}

/**
 * The options routes that read an argument, and the parameter each one reads.
 * `#settings` has no field for one, so appending a parameter there would build
 * a url the page ignores.
 */
const META_PARAMS: Record<string, string> = {
  help: 'q',
  new: 'prefill',
};

function meta(args: string, cmd: Command, _settings: Settings): string {
  const base = (cmd.url || 'options.html').trim().replace(/^\.?\//, '');
  const query = args.trim();
  if (!query) return base;

  const hash = base.indexOf('#');
  const tail = hash === -1 ? base : base.slice(hash + 1);
  const route = tail.split('?')[0];
  const param = META_PARAMS[route];
  if (!param) return base;
  const sep = tail.includes('?') ? '&' : '?';
  return `${base}${sep}${param}=${enc(query)}`;
}

/**
 * SHAPE GUARDS
 *
 * A command whose destination interpolates its argument into a NON-query slot —
 * a path segment, a meeting id, a tracking number — cannot take free text: the
 * slot has a shape, and words jammed into it build a url the site cannot serve
 * (an invalid join link, "tracking number not found"). Everything below pairs
 * that shape with a degrade that keeps the words the user typed.
 */

/** Zoom personal and scheduled meeting ids are 9-11 digits. */
const ZOOM_MEETING = /^\d{9,11}$/;

/** Google Meet codes are `abc-defg-hij`. */
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

/** A carrier tracking number: alphanumeric, no spaces, at least one digit. */
const TRACKING_NUMBER = /^(?=[a-z0-9]*\d)[a-z0-9]{10,}$/i;

const INSTAGRAM_HANDLE = /^[a-z0-9._]{1,30}$/i;


/** Digits only by the time it is checked; `+`, spaces and dashes are stripped. */
const PHONE_NUMBER = /^\d{7,15}$/;

/** A headword, not a phrase: dictionaries key their pages on one word. */
const DICTIONARY_WORD = /^[a-z][a-z'-]{0,30}$/i;

/** Where an argument goes when it fails the guard in front of the slot. */
type Degrade = (args: string, cmd: Command, settings: Settings, keyword: string) => string;

const site =
  (host: string): Degrade =>
  (args) =>
    googleSite(host, args);

/** A `site:` search of the command's own domain. */
const ownSite: Degrade = (args, cmd) => googleSite(commandHost(cmd.url), args);

/** For sites with nothing indexed to search: reproduce what the user typed. */
const plain: Degrade = (args, _cmd, settings, keyword) => plainSearch(keyword, args, settings);

/**
 * Builds the handler for a command whose `searchUrl` fills a non-query slot.
 * Only an argument that matches `shape` (after `normalize` fixes up the way
 * people actually type it) reaches the template; anything else degrades.
 */
function slot(
  shape: RegExp,
  fallback: Degrade,
  normalize: (raw: string) => string = (raw) => raw,
): HandlerFn {
  return (args, cmd, settings, keyword = '') => {
    const raw = args.trim();
    if (!raw) return cmd.url;
    const value = normalize(raw);
    const template = cmd.searchUrl ?? '';
    if (value && template.includes('{q}') && shape.test(value)) {
      return template.split('{q}').join(encodePath(value));
    }
    return fallback(raw, cmd, settings, keyword);
  };
}

const stripAt = (raw: string): string => raw.replace(/^@/, '');

export const HANDLERS: Record<HandlerId, HandlerFn> = {
  github,
  githubPulls,
  githubIssues,
  githubGist,
  reddit,
  npm,
  gmail,
  gdrive,
  gcal,
  googleApp,
  outlook,
  onedrive,
  teams,
  ai,
  brightspace,
  gradescope,
  youtube,
  meta,
  zoom: slot(ZOOM_MEETING, site('zoom.us'), (raw) => raw.replace(/[\s-]/g, '')),
  meet: slot(MEET_CODE, plain, (raw) =>
    raw.replace(/^(?:https?:\/\/)?meet\.google\.com\//i, '').replace(/\/+$/, ''),
  ),
  tracking: slot(TRACKING_NUMBER, ownSite),
  instagram: slot(INSTAGRAM_HANDLE, site('instagram.com'), stripAt),
  whatsapp: slot(PHONE_NUMBER, site('whatsapp.com'), (raw) => raw.replace(/[\s()+.-]/g, '')),
  word: slot(DICTIONARY_WORD, ownSite),
};
