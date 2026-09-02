/**
 * Persistence: one JSON blob under one key in `chrome.storage.local`.
 *
 * Deliberately not `storage.sync` — the same person runs Chrome, Brave and Dia
 * side by side, so each profile keeps its own state and shortcuts travel
 * between them through the export/import file instead.
 *
 * Everything coming out of storage or off disk is treated as hostile: a
 * half-finished write, a hand-edited export or a blob from a future build must
 * degrade to defaults rather than throw on a navigation path. `importJson` is
 * the one exception — it throws, because a human is standing in the options
 * page waiting to read the message.
 */

import type { Category, Command, HandlerId, Overrides, SearchEngineId, Settings, StoredState } from './types';
import { CATEGORIES, DEFAULT_OVERRIDES, DEFAULT_SETTINGS, DEFAULT_STOP_LIST, STORAGE_KEY } from './types';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from './commands';
import { mergeCommands } from './resolve';
import { clone } from './text';
import { validateAlias, validateUrlTemplate } from './validate';

/** Bumped only when the export file's shape changes incompatibly. */
const EXPORT_VERSION = 1;

const ENGINE_IDS = new Set<string>(SEARCH_ENGINES.map((engine) => engine.id));

/** Narrow feature test so this module imports cleanly under vitest in Node. */
function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && chrome.storage?.local != null;
}

export async function loadState(): Promise<StoredState> {
  try {
    return await readState();
  } catch {
    // A read can fail transiently (profile teardown, corrupted record). Defaults
    // keep every surface navigable instead of blanking the page.
    return normalizeState(null);
  }
}

export async function saveState(state: StoredState): Promise<void> {
  if (!hasChromeStorage()) return;
  // Normalizing on the way out keeps the stored blob canonical, so a bad value
  // that slipped past a UI form never survives a round trip.
  await chrome.storage.local.set({ [STORAGE_KEY]: normalizeState(state) });
}

export async function saveOverrides(overrides: Overrides): Promise<void> {
  // `readState`, not `loadState`: a read failure must abort the write rather
  // than silently overwrite the user's settings with defaults.
  const current = await readState();
  await saveState({ overrides, settings: current.settings });
}

export async function saveSettings(settings: Settings): Promise<void> {
  const current = await readState();
  await saveState({ overrides: current.overrides, settings });
}

/** The single call every consumer makes before resolving a query. */
export async function loadResolveContext(): Promise<{ commands: Command[]; settings: Settings }> {
  const { overrides, settings } = await loadState();
  return { commands: mergeCommands(BUILTIN_COMMANDS, overrides), settings };
}

/**
 * The user's own data only. The builtin registry ships with the extension, so
 * dumping it here would bloat the file and, worse, freeze today's builtins into
 * a file that gets imported into a later version.
 */
export function exportJson(state: StoredState): string {
  const { overrides, settings } = normalizeState(state);
  return JSON.stringify({ version: EXPORT_VERSION, overrides, settings }, null, 2);
}

/**
 * The result of reading an import file. `settings` is null when the file had no
 * "settings" key at all — a shortcuts-only snippet must not be mistaken for
 * "reset every setting to its default".
 */
export interface ImportedState {
  overrides: Overrides;
  settings: Settings | null;
}

/**
 * Folds an import onto the state currently in storage. Callers (the options
 * page) must route every `importJson` result through this instead of saving it
 * directly, or importing a bare-overrides file wipes githubUser, defaultEngine,
 * googleAccount and the intercept toggles.
 */
export function applyImport(imported: ImportedState, current: StoredState): StoredState {
  const base = normalizeState(current);
  return {
    overrides: imported?.overrides ?? base.overrides,
    settings: imported?.settings ? normalizeSettings(imported.settings) : base.settings,
  };
}

/**
 * Parses an export file. Accepts a full `StoredState` or a bare `Overrides`
 * object, and throws an `Error` whose message is safe to show verbatim.
 */
export function importJson(text: string): ImportedState {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Nothing to import — the file is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`That file is not valid JSON: ${(err as Error).message}`);
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error('Expected a JSON object with "overrides" and "settings" at the top level.');
  }

  const version = root.version;
  if (typeof version === 'number' && version > EXPORT_VERSION) {
    throw new Error(
      `This file came from a newer version of BunnyLol (format ${version}, this build reads ${EXPORT_VERSION}).`,
    );
  }

  if (root.overrides !== undefined && !asRecord(root.overrides)) {
    throw new Error('"overrides" must be an object with "disabled", "keyOverrides" and "custom".');
  }
  if (root.settings !== undefined && !asRecord(root.settings)) {
    throw new Error('"settings" must be an object.');
  }

  // A bare Overrides object is accepted so a snippet copied out of the options
  // page imports without hand-editing it into a full state file.
  const overrides = asRecord(root.overrides) ?? (looksLikeOverrides(root) ? root : null);
  if (!overrides && root.settings === undefined) {
    throw new Error('That file has no BunnyLol data in it — expected "overrides" or "settings".');
  }

  return {
    overrides: parseOverrides(overrides),
    // Absent, not empty: `applyImport` keeps the user's current settings.
    settings: root.settings === undefined ? null : parseSettings(asRecord(root.settings) ?? {}),
  };
}

/**
 * Strict counterpart to `normalizeSettings` for the URL-shaped fields only.
 *
 * A `defaultEngine` that is not a URL is the worst single value in the file:
 * it does not break one shortcut, it breaks every query that matches none,
 * because `toNavigableUrl` reads a scheme-less string as an extension-relative
 * path. Silently swapping it for the default would hide the user's typo, so
 * this is the one place settings refuse instead of degrade. Everything else —
 * an unknown engine id, a negative account index — is still normalized away.
 */
function parseSettings(source: Record<string, unknown>): Settings {
  // Absent or blank means "not configured" and keeps the shipped default; only
  // a value that says something unusable is an error.
  const engine = trimmed(source.defaultEngine);
  if (engine) {
    const check = validateUrlTemplate(engine);
    if (!check.ok) throw new Error(`"settings.defaultEngine" ${check.reason}.`);
  } else if (source.defaultEngine !== undefined && typeof source.defaultEngine !== 'string') {
    throw new Error('"settings.defaultEngine" must be a URL template string containing {q}.');
  }

  const templates = asRecord(source.aiTemplates);
  if (source.aiTemplates !== undefined && !templates) {
    throw new Error('"settings.aiTemplates" must be an object mapping an AI provider id to a URL template.');
  }
  for (const [id, template] of Object.entries(templates ?? {})) {
    if (!trimmed(template)) continue;
    const check = validateUrlTemplate(trimmed(template));
    if (!check.ok) throw new Error(`"settings.aiTemplates.${id}" ${check.reason}.`);
  }

  return normalizeSettings(source);
}

export function onStateChanged(cb: (s: StoredState) => void): void {
  if (!hasChromeStorage() || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[STORAGE_KEY];
    // `newValue` is undefined when the key was cleared, which normalizes to
    // defaults — exactly what a listener should render at that point.
    if (change) cb(normalizeState(change.newValue));
  });
}

/** Throws when storage itself fails; returns defaults when there is no chrome. */
async function readState(): Promise<StoredState> {
  if (!hasChromeStorage()) return normalizeState(null);
  const bag = await chrome.storage.local.get<Record<string, unknown>>(STORAGE_KEY);
  return normalizeState(bag?.[STORAGE_KEY]);
}

function normalizeState(raw: unknown): StoredState {
  const source = asRecord(raw);
  return {
    overrides: normalizeOverrides(source?.overrides),
    settings: normalizeSettings(source?.settings),
  };
}

/**
 * Stored settings are merged field by field on top of `DEFAULT_SETTINGS`, so a
 * field added in a later build is never `undefined` on an old profile.
 */
function normalizeSettings(raw: unknown): Settings {
  const source = asRecord(raw);
  if (!source) return clone(DEFAULT_SETTINGS);
  return {
    githubUser: trimmed(source.githubUser),
    defaultEngine: safeUrl(source.defaultEngine) || DEFAULT_SETTINGS.defaultEngine,
    defaultAi: trimmed(source.defaultAi).toLowerCase() || DEFAULT_SETTINGS.defaultAi,
    interceptEngines: normalizeEngines(source.interceptEngines),
    aiTemplates: normalizeTemplates(source.aiTemplates),
    googleAccount: normalizeAccount(source.googleAccount),
    interceptStopList: normalizeStopList(source.interceptStopList),
    dispatchToast: source.dispatchToast === true,
  };
}

/**
 * The exemption list. Missing means "never configured" and gets the shipped
 * default, which is empty — every registered keyword is intercepted until the
 * user exempts one by name.
 */
function normalizeStopList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_STOP_LIST];
  return normalizeAliases(raw);
}

function normalizeEngines(raw: unknown): SearchEngineId[] {
  // Missing means "never configured" and gets the defaults; an empty array is a
  // real choice — the user turned interception off entirely.
  if (!Array.isArray(raw)) return [...DEFAULT_SETTINGS.interceptEngines];
  const ids: SearchEngineId[] = [];
  for (const entry of raw) {
    const id = trimmed(entry).toLowerCase();
    if (!ENGINE_IDS.has(id) || ids.includes(id as SearchEngineId)) continue;
    ids.push(id as SearchEngineId);
  }
  return ids;
}

function normalizeTemplates(raw: unknown): Record<string, string> {
  const source = asRecord(raw);
  const templates: Record<string, string> = {};
  if (!source) return templates;
  for (const [id, template] of Object.entries(source)) {
    const value = safeUrl(template);
    if (id.trim() && value) templates[id.trim()] = value;
  }
  return templates;
}

function normalizeAccount(raw: unknown): number {
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_SETTINGS.googleAccount;
  }
  return Math.floor(value);
}

function normalizeOverrides(raw: unknown): Overrides {
  const source = asRecord(raw);
  if (!source) return clone(DEFAULT_OVERRIDES);
  return {
    disabled: normalizeAliases(source.disabled),
    keyOverrides: normalizeKeyOverrides(source.keyOverrides),
    custom: normalizeCustom(source.custom),
  };
}

function normalizeKeyOverrides(raw: unknown): Record<string, string[]> {
  const source = asRecord(raw);
  const out: Record<string, string[]> = {};
  if (!source) return out;
  for (const [key, aliases] of Object.entries(source)) {
    const canonical = validateAlias(key);
    const list = normalizeAliases(aliases);
    // `mergeCommands` already reads an empty list as "no override", so dropping
    // the entry here keeps the stored blob from collecting dead keys.
    if (canonical.ok && list.length > 0) out[canonical.alias] = list;
  }
  return out;
}

function normalizeCustom(raw: unknown): Command[] {
  if (!Array.isArray(raw)) return [];
  const commands: Command[] = [];
  for (const entry of raw) {
    const cmd = normalizeCommand(entry);
    if (cmd) commands.push(cmd);
  }
  return commands;
}

/** Returns null when the entry has no usable keyword or destination. */
function normalizeCommand(raw: unknown): Command | null {
  const source = asRecord(raw);
  if (!source) return null;
  const keys = normalizeAliases(source.keys);
  const url = safeUrl(source.url);
  if (keys.length === 0 || !url) return null;

  const cmd: Command = {
    keys,
    name: trimmed(source.name) || keys[0],
    description: trimmed(source.description),
    url,
    category: normalizeCategory(source.category),
    // A custom command is never builtin, whatever the file claims.
    builtin: false,
  };
  const searchUrl = safeUrl(source.searchUrl);
  if (searchUrl) cmd.searchUrl = searchUrl;
  const example = trimmed(source.example);
  if (example) cmd.example = example;
  // Unknown handler ids are kept rather than dropped: `resolve` falls back to
  // `cmd.url` for a handler this build doesn't have, and the id becomes live
  // again if the file is imported into a build that does.
  if (typeof source.handler === 'string' && source.handler.trim()) {
    cmd.handler = source.handler.trim() as HandlerId;
  }
  return cmd;
}

/** Exported so the options form narrows an open `Draft.category` the same way a
 *  stored blob is narrowed: an id nobody ships files under "custom". */
export function normalizeCategory(raw: unknown): Category {
  const value = trimmed(raw).toLowerCase() as Category;
  return CATEGORIES.includes(value) ? value : 'custom';
}

/** Lenient recovery: an alias the resolver could never match is dropped, not kept. */
function normalizeAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const aliases: string[] = [];
  for (const entry of raw) {
    const check = validateAlias(trimmed(entry));
    if (check.ok && !aliases.includes(check.alias)) aliases.push(check.alias);
  }
  return aliases;
}

function parseOverrides(source: Record<string, unknown> | null): Overrides {
  if (!source) return clone(DEFAULT_OVERRIDES);
  if (source.disabled !== undefined && !Array.isArray(source.disabled)) {
    throw new Error('"disabled" must be an array of shortcut keywords.');
  }
  if (source.keyOverrides !== undefined && !asRecord(source.keyOverrides)) {
    throw new Error('"keyOverrides" must be an object mapping a keyword to its replacements.');
  }
  if (source.custom !== undefined && !Array.isArray(source.custom)) {
    throw new Error('"custom" must be an array of shortcuts.');
  }
  const custom: Command[] = (Array.isArray(source.custom) ? source.custom : []).map(
    (entry: unknown, index: number) => parseCustomCommand(entry, index),
  );
  return {
    // `disabled` stays lenient: its entries name builtins the user turned off,
    // so an unmatchable one costs nothing but a dead line in the file.
    disabled: normalizeAliases(source.disabled),
    keyOverrides: parseKeyOverrides(source.keyOverrides),
    custom,
  };
}

/**
 * Strict counterpart to `normalizeKeyOverrides`. A rebinding to `"foo bar"` is
 * the same silent death as a custom command with a space in its keyword — the
 * user rebinds `gh`, sees the file import cleanly, and their keyword answers to
 * nothing.
 */
function parseKeyOverrides(raw: unknown): Record<string, string[]> {
  const source = asRecord(raw);
  const out: Record<string, string[]> = {};
  if (!source) return out;
  for (const [key, aliases] of Object.entries(source)) {
    // A blank key carries no instruction at all; only a key that says something
    // unusable is worth refusing the file over.
    if (!key.trim()) continue;
    const canonical = validateAlias(key);
    if (!canonical.ok) {
      throw new Error(`"keyOverrides" has a keyword that ${canonical.reason}.`);
    }
    if (!Array.isArray(aliases)) {
      throw new Error(`"keyOverrides.${canonical.alias}" must be an array of replacement keywords.`);
    }
    const list = parseAliasList(aliases, `"keyOverrides.${canonical.alias}"`);
    // `mergeCommands` already reads an empty list as "no override", so dropping
    // the entry here keeps the stored blob from collecting dead keys.
    if (list.length > 0) out[canonical.alias] = list;
  }
  return out;
}

/** Deduped and validated, throwing about the first entry that cannot ever match. */
function parseAliasList(raw: unknown[], label: string): string[] {
  const aliases: string[] = [];
  for (const entry of raw) {
    const text = trimmed(entry);
    // An empty slot is a formatting artifact, not a mistake worth a refusal.
    if (!text) continue;
    const check = validateAlias(text);
    if (!check.ok) throw new Error(`${label} has a keyword that ${check.reason}.`);
    if (!aliases.includes(check.alias)) aliases.push(check.alias);
  }
  return aliases;
}

/**
 * Strict counterpart to `normalizeCommand`: same result, but it explains what
 * is wrong instead of quietly dropping the entry, because an import that
 * silently loses half the user's shortcuts is worse than a refused import.
 */
function parseCustomCommand(raw: unknown, index: number): Command {
  const label = `Shortcut #${index + 1}`;
  const source = asRecord(raw);
  if (!source) throw new Error(`${label} is not a JSON object.`);

  const keys = parseAliasList(Array.isArray(source.keys) ? source.keys : [], label);
  if (keys.length === 0) {
    throw new Error(`${label} has no keyword — every shortcut needs a "keys" list of strings.`);
  }
  if (!trimmed(source.url)) {
    throw new Error(`Shortcut "${keys[0]}" is missing its "url".`);
  }
  if (source.searchUrl !== undefined && typeof source.searchUrl !== 'string') {
    throw new Error(`Shortcut "${keys[0]}" has a "searchUrl" that is not a string.`);
  }

  const url = validateUrlTemplate(trimmed(source.url));
  if (!url.ok) {
    throw new Error(`Shortcut "${keys[0]}" has a "url" BunnyLol will not open: it ${url.reason}.`);
  }
  const rawSearch = trimmed(source.searchUrl);
  if (rawSearch) {
    const searchUrl = validateUrlTemplate(rawSearch);
    if (!searchUrl.ok) {
      throw new Error(
        `Shortcut "${keys[0]}" has a "searchUrl" BunnyLol will not open: it ${searchUrl.reason}.`,
      );
    }
  }

  const cmd = normalizeCommand(source);
  // Unreachable while the checks above mirror `normalizeCommand`'s two bail-outs
  // — kept so the strict and lenient paths cannot silently drift apart into an
  // import that returns nothing and says nothing.
  if (!cmd) throw new Error(`Shortcut "${keys[0]}" points at a URL BunnyLol will not open.`);
  return cmd;
}

function looksLikeOverrides(root: Record<string, unknown>): boolean {
  return 'custom' in root || 'disabled' in root || 'keyOverrides' in root;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The lenient half of the URL boundary: an unusable destination becomes an
 * empty string, which each caller turns into a default or a dropped entry. A
 * stored blob that predates this check must not be able to brick the profile,
 * so nothing here throws.
 */
function safeUrl(value: unknown): string {
  const check = validateUrlTemplate(trimmed(value));
  return check.ok ? check.url : '';
}
