/**
 * Shared contract for the whole extension.
 *
 * Every other module builds against these types. Nothing in here may import
 * `chrome.*` or touch the DOM — it is imported by the pure resolver, the
 * service worker, all three UI surfaces, and the tests.
 */

export type Category =
  | 'ai'
  | 'search'
  | 'dev'
  | 'google'
  | 'microsoft'
  | 'purdue'
  | 'social'
  | 'media'
  | 'productivity'
  | 'meta'
  | 'custom';

export const CATEGORIES: Category[] = [
  'ai',
  'search',
  'dev',
  'google',
  'microsoft',
  'purdue',
  'social',
  'media',
  'productivity',
  'meta',
  'custom',
];

export const CATEGORY_LABELS: Record<Category, string> = {
  ai: 'AI',
  search: 'Search',
  dev: 'Developer',
  google: 'Google',
  microsoft: 'Microsoft',
  purdue: 'Purdue',
  social: 'Social',
  media: 'Media',
  productivity: 'Productivity',
  meta: 'BunnyLol',
  custom: 'My shortcuts',
};

/**
 * Identifies a "smart" argument handler in `handlers.ts`. A command with a
 * handler bypasses plain `{q}` substitution: `resolve()` hands the handler the
 * raw arguments, and the handler decides whether `searchUrl` is consulted. Most
 * ignore it; the multi-tenant handlers (brightspace, gradescope) and the
 * slot-shaped ones degrade their words through it, so it is a live, editable
 * field on those rows rather than dead weight.
 */
export type HandlerId =
  | 'github'
  | 'githubPulls'
  | 'githubIssues'
  | 'githubGist'
  | 'reddit'
  | 'npm'
  | 'gmail'
  | 'gdrive'
  | 'gcal'
  | 'googleApp'
  | 'outlook'
  | 'onedrive'
  | 'teams'
  | 'ai'
  | 'brightspace'
  | 'gradescope'
  | 'youtube'
  | 'meta'
  | 'zoom'
  | 'meet'
  | 'tracking'
  | 'instagram'
  | 'whatsapp'
  | 'word';

export interface Command {
  /**
   * Stable identity, independent of the aliases. A shipped command omits it and
   * is identified by its SHIPPED `keys[0]`, which never moves because the
   * registry is code; a user-created one carries a generated `u:`-prefixed id
   * that survives every key edit. `mergeCommands` and the storage boundary
   * stamp the resolved value onto everything they emit, so the override maps,
   * the browse rows and the resolver all key off one string. Never authored in
   * `commands.ts`, never user-editable.
   */
  id?: string;
  /** Aliases. `keys[0]` is canonical, and for a shipped command it is the `id`. */
  keys: string[];
  name: string;
  description: string;
  /** Where a bare invocation (no arguments) goes. */
  url: string;
  /** Where `<key> <args>` goes. `{q}` is replaced with URI-encoded arguments. */
  searchUrl?: string;
  /** Opt into a smart handler instead of plain `{q}` substitution. */
  handler?: HandlerId;
  category: Category;
  builtin: boolean;
  /** Shown in the UI, e.g. "gh facebook/react -> github.com/facebook/react". */
  example?: string;
  /**
   * Stable identity for handlers that must not depend on the live alias.
   * `keys[0]` changes when the user rebinds a builtin, so the `ai` handler
   * dispatches on this instead. Set on builtins only.
   */
  provider?: string;
}

/** A provider whose web UI accepts a prompt via URL parameter. */
export interface AiProvider {
  id: string;
  label: string;
  /** URL template containing `{q}`. Editable from the options page. */
  template: string;
  /** Where a bare invocation goes. */
  home: string;
}

export interface Settings {
  /** Used by `gh me`, `pr`, `iss`. */
  githubUser: string;
  /** Where an unrecognized query goes. Template containing `{q}`. */
  defaultEngine: string;
  /**
   * `AiProvider.id` the `?` command routes to. A provider id, not an alias:
   * the user can rebind the Claude builtin's keys, and `?` must keep pointing
   * at the provider they picked rather than at whatever now answers to `c`.
   */
  defaultAi: string;
  /** Which search engines DNR intercepts. Values are `SearchEngineId`s. */
  interceptEngines: SearchEngineId[];
  /** Overrides for `AI_PROVIDERS` templates, keyed by provider id. */
  aiTemplates: Record<string, string>;
  /** Google Workspace account index, e.g. 0 or 1, for /u/N/ URLs. */
  googleAccount: number;
  /**
   * Aliases the user has EXEMPTED from address-bar interception. Empty by
   * default; see `DEFAULT_STOP_LIST`.
   */
  interceptStopList: string[];
  /**
   * Show a dismissible toast on the dispatch page naming the command that
   * fired, with a link to search instead. Off by default because it costs
   * ~1.2s on every dispatch; see `TOAST_MS` in go.ts.
   */
  dispatchToast: boolean;
}

export type SearchEngineId = 'google' | 'bing' | 'duckduckgo';

export interface SearchEngine {
  id: SearchEngineId;
  label: string;
  /** Host pattern for `host_permissions` / DNR, e.g. "www.google.com". */
  host: string;
  /** Regex source matching this engine's results URL up to the `q=` value. */
  urlPrefixPattern: string;
}

/** The user's customization layer. Builtins are never mutated in place. */
export interface Overrides {
  /** Canonical keys of builtins the user turned off. */
  disabled: string[];
  /** Canonical key -> replacement alias list. */
  keyOverrides: Record<string, string[]>;
  /** User-created commands. Always `builtin: false`. */
  custom: Command[];
}

export interface StoredState {
  overrides: Overrides;
  settings: Settings;
}

/** What the resolver produces. Never throws; always yields a navigable URL. */
export interface ResolveResult {
  url: string;
  /** The matched command, or null when we fell through to the default engine. */
  command: Command | null;
  /** Raw arguments after the keyword, trimmed. Empty string when bare. */
  args: string;
  /** True when no command matched and we used `settings.defaultEngine`. */
  fallback: boolean;
}

/**
 * `keyword` is the alias the user actually typed, which a handler needs when
 * its degrade is a plain search: reproducing the query the alias intercepted
 * ("lh surge meaning") requires the keyword, and `cmd.keys[0]` is the canonical
 * alias rather than the typed one. Optional so a handler called directly — the
 * tests, an imported command — still type-checks.
 */
export type HandlerFn = (args: string, cmd: Command, settings: Settings, keyword?: string) => string;

/**
 * The user's EXEMPTION list: aliases they have asked BunnyLol to leave out of
 * address-bar interception.
 *
 * Empty on purpose. BunnyLol follows true bunnylol semantics — if the first
 * word of an address-bar query is a registered keyword, it IS a command, every
 * time. `c programming tutorial` opens Claude and `pr firms in new york` opens
 * your pull requests, and that is the contract rather than a bug: a blocklist
 * of "words that look like English" was an endless tail, and every entry on it
 * made the address bar less predictable rather than more.
 *
 * What makes that liveable is the escape hatch (`FORCE_SEARCH_PREFIXES`), not
 * a curated list. This list stays because one user in ten will keep tripping
 * over one specific keyword — "I search for 'maps of X' constantly" — and the
 * options page lets them exempt exactly that alias. An exempted alias loses
 * address-bar interception and nothing else: it still resolves from the `bl`
 * omnibox keyword and the toolbar popup.
 */
export const DEFAULT_STOP_LIST: string[] = [];

/**
 * A leading one of these forces a plain default-engine search of whatever
 * follows: `\\gh foo` and `=gh foo` both search for "gh foo" rather than
 * opening GitHub.
 *
 * TWO of them, defined here once and consumed by both the resolver and the DNR
 * rule builder. `\\` is the traditional bunnylol escape but needs AltGr on
 * several European layouts and is the character most likely to be mangled on
 * the way into a URL; `=` is one unshifted keystroke everywhere and is never
 * the first character of a real search.
 *
 * ORDER MATTERS ONLY FOR DOCS — matching tries each in turn, and no prefix here
 * may be a prefix of another.
 */
export const FORCE_SEARCH_PREFIXES: string[] = ['\\', '='];

export const DEFAULT_SETTINGS: Settings = {
  githubUser: '',
  defaultEngine: 'https://www.google.com/search?q={q}',
  defaultAi: 'claude',
  interceptEngines: ['google', 'bing', 'duckduckgo'],
  aiTemplates: {},
  googleAccount: 0,
  interceptStopList: [...DEFAULT_STOP_LIST],
  dispatchToast: false,
};

export const DEFAULT_OVERRIDES: Overrides = {
  disabled: [],
  keyOverrides: {},
  custom: [],
};

export const STORAGE_KEY = 'bunnylol.state.v1';

/** Messages the UI surfaces send to the service worker. */
export type BgMessage =
  | { type: 'resyncRules' }
  | { type: 'getRuleStatus' }
  | { type: 'getExtensionId' };

export interface RuleStatus {
  /** Dynamic rules Chrome actually holds, read back after the sync. */
  registered: number;
  /**
   * Aliases the registered rules really do intercept, on every selected engine.
   * NOT the number of aliases that were eligible: a shard Chrome refuses to
   * compile, or one past the rule budget, costs coverage, and the whole point of
   * this field is to say so.
   */
  keywords: number;
  /** Aliases the user exempted through `settings.interceptStopList`. */
  suppressed: number;
  /** Eligible aliases that ended up with no rule — `keywords + dropped` is the eligible total. */
  dropped: number;
  /**
   * Set only when the sync itself failed and interception is not working.
   *
   * Split from `warning` because the two need different words and a different
   * colour: partial coverage used to be reported here, which painted the fatal
   * red state over a working extension and left the amber one unreachable.
   */
  error: string | null;
  /** Set when the sync succeeded but could not cover every keyword. */
  warning: string | null;
  extensionId: string;
}

/**
 * Appended to a BunnyLol-generated fallback search so our own DNR rules skip
 * it. Without this, a `FORCE_SEARCH_PREFIXES` escape is redirected straight
 * back into the dispatch page by the very rule it is meant to bypass.
 */
export const PASSTHROUGH_PARAM = 'blpass';
