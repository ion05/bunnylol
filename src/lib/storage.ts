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

import type {
  Command,
  HandlerId,
  Overrides,
  SearchEngineId,
  Section,
  Settings,
  ShortcutEdit,
  StoredState,
} from './types';
import {
  CATEGORIES,
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  DEFAULT_STOP_LIST,
  FALLBACK_SECTION,
  STORAGE_KEY,
} from './types';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from './commands';
import {
  MAX_ID_LENGTH,
  MAX_SECTIONS,
  USER_ID_PREFIX,
  foldLegacyKeyOverrides,
  isUserId,
  knownCategoryIds,
  mintUserId,
  normalizeId,
  shortcutId,
} from './overrides';
import { mergeCommands } from './resolve';
import { clone } from './text';
import { validateAlias, validateSectionId, validateSectionLabel, validateUrlTemplate } from './validate';

/**
 * Bumped only when the export file's shape changes incompatibly. Format 2
 * replaced `keyOverrides` with the `edits` layer; format 1 files still load,
 * through `foldLegacyKeyOverrides`.
 */
const EXPORT_VERSION = 2;

/**
 * Ids this build actually ships, used to prune `deleted`: an entry naming a
 * command that no longer exists is a shortcut nobody can restore, and keeping
 * it would let one removed in v1.0 come back as a tombstone forever. `edits`
 * for a vanished id are left alone — they are inert and cost nothing.
 */
const SHIPPED_IDS = new Set(BUILTIN_COMMANDS.map(shortcutId));

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
    throw new Error(
      '"overrides" must be an object with "disabled", "deleted", "edits", "sections" and "custom".',
    );
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
  // Sections FIRST: a category is an open id resolved against them, so reading
  // the commands before the groups they are filed under would send every
  // shortcut in a user section to "My shortcuts".
  const sections = normalizeSections(source.sections);
  const known = knownCategoryIds(sections);
  return {
    disabled: normalizeIdList(source.disabled),
    // Pruned, not kept: see `SHIPPED_IDS`.
    deleted: normalizeIdList(source.deleted).filter((id) => SHIPPED_IDS.has(id)),
    // The v1 migration, on the stored blob. Its strict twin in `parseOverrides`
    // is the v1 *file* reader; one implementation, two callers.
    edits: foldLegacyKeyOverrides(
      normalizeEdits(source.edits, known),
      normalizeKeyOverrides(source.keyOverrides),
    ),
    sections,
    custom: normalizeCustom(source.custom, known),
    enabledCategories: normalizeCategoryPick(source.enabledCategories),
    // Pruned like `deleted`, and for the reason in `SHIPPED_IDS`: an id here
    // says "this profile has already been offered that shortcut", and one for a
    // command no build ships is a claim about nothing that keeps the list
    // growing across every version the user upgrades through.
    seenBuiltins: normalizeIdList(source.seenBuiltins).filter((id) => SHIPPED_IDS.has(id)),
  };
}

/**
 * The onboarding pick. `null` when the profile has no array there at all, which
 * is the one signal that says "this user has never seen the picker"; an empty
 * array is a real answer and survives as one.
 *
 * Filtered to `CATEGORIES` rather than to the known section ids: a pick names
 * shipped packs, and a user section holds no builtins for it to have an effect
 * on.
 */
function normalizeCategoryPick(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const picked: string[] = [];
  for (const entry of raw) {
    const id = trimmed(entry).toLowerCase();
    if ((CATEGORIES as string[]).includes(id) && !picked.includes(id)) picked.push(id);
  }
  return picked;
}

/**
 * Shortcut ids off a stored blob: trimmed, lowercased, deduped, and dropping
 * anything that could never name a shortcut.
 *
 * Not `normalizeAliases`: an id is not an alias. `u:tix` is a legal id and a
 * `\`-prefixed one is not an alias at all, so routing ids through the keyword
 * rules would quietly drop half the user's own shortcuts from `disabled`.
 */
function normalizeIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    const id = normalizeId(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The edit layer, field by field. Never reads `handler`, `provider`, `builtin`
 * or `id` — an edit that names them is not a shortcut definition, it is an
 * attempt to become one (invariant 16).
 *
 * An entry that ends up with no fields is dropped entirely, so "reset to
 * shipped" is representable as the absence of an entry and the stored blob
 * stays canonical.
 */
function normalizeEdits(raw: unknown, known: Set<string>): Record<string, ShortcutEdit> {
  const source = asRecord(raw);
  // Null-prototype: see `parseEdits`. A stored blob is untrusted for the same
  // reason a file is — it is where an import file ends up.
  const out: Record<string, ShortcutEdit> = Object.create(null);
  if (!source) return out;
  for (const [key, value] of Object.entries(source)) {
    const id = normalizeId(key);
    const entry = asRecord(value);
    // Edits are for SHIPPED shortcuts: a custom command has nothing to diff
    // against and is edited in place, so an entry under a `u:` id is a second
    // writer for fields storage already owns.
    if (!id || !entry || isUserId(id)) continue;
    const edit = normalizeEdit(entry, known);
    if (edit) out[id] = edit;
  }
  return out;
}

/** Returns null when nothing usable is left, which is what makes an empty edit
 *  unrepresentable in the stored blob. */
function normalizeEdit(source: Record<string, unknown>, known: Set<string>): ShortcutEdit | null {
  const edit: ShortcutEdit = {};

  const keys = normalizeAliases(source.keys);
  if (keys.length > 0) edit.keys = keys;

  const name = trimmed(source.name);
  if (name) edit.name = name;
  // A cleared description is a real instruction, unlike a cleared name.
  if (typeof source.description === 'string') edit.description = source.description.trim();

  // This is where a blank or unparseable edited url dies, rather than at the
  // merge layer: `applyEdit` would inherit the shipped one anyway, and keeping
  // the string would show the user a saved edit that does nothing.
  const url = safeUrl(source.url);
  if (url) edit.url = url;

  // `null` survives normalization on both optional fields: it says "the user
  // removed this", which absence cannot say.
  if (source.searchUrl === null) edit.searchUrl = null;
  else {
    const searchUrl = safeUrl(source.searchUrl);
    if (searchUrl) edit.searchUrl = searchUrl;
  }

  // ASYMMETRIC with `normalizeCommand` on purpose: an unknown id is DROPPED
  // here rather than coerced to `FALLBACK_SECTION`. A custom command has no
  // other category to fall back to, but a shipped one does — its own — and
  // relocating it to "My shortcuts" because a section vanished would move a
  // shortcut the user never touched.
  const category = trimmed(source.category).toLowerCase();
  if (known.has(category)) edit.category = category;

  if (source.example === null) edit.example = null;
  else {
    const example = trimmed(source.example);
    if (example) edit.example = example;
  }

  return Object.keys(edit).length > 0 ? edit : null;
}

/** Sections are data here; the algebra that resolves a command's category
 *  against them lands with the section editor. */
function normalizeSections(raw: unknown): Section[] {
  if (!Array.isArray(raw)) return [];
  const sections: Section[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const source = asRecord(entry);
    if (!source) continue;
    const id = validateSectionId(trimmed(source.id));
    const label = validateSectionLabel(typeof source.label === 'string' ? source.label : '');
    if (!id.ok || !label.ok || seen.has(id.id)) continue;
    seen.add(id.id);
    sections.push({ id: id.id, label: label.label });
    // The cap counts sections the user ends up with, so it is applied to what
    // survived validation: capping the input first would let a corrupt blob
    // spend the whole budget on entries that were going to be dropped anyway.
    if (sections.length >= MAX_SECTIONS) break;
  }
  return sections;
}

/**
 * Reads the format-1 `keyOverrides` map. Kept, not deleted: it is the only
 * thing standing between a v1.0 profile and a silently un-rebound `gh`. Its
 * result is folded into `edits[id].keys` by `normalizeOverrides`.
 */
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

function normalizeCustom(raw: unknown, known: Set<string>): Command[] {
  if (!Array.isArray(raw)) return [];
  const entries: CustomEntry[] = [];
  for (const entry of raw) {
    const cmd = normalizeCommand(entry, known);
    if (cmd) entries.push({ cmd, raw: entry });
  }
  return assignCustomIds(entries, false);
}

/** A normalized custom command next to the entry it came from, which still
 *  carries the `id` the file claimed. */
interface CustomEntry {
  cmd: Command;
  raw: unknown;
}

/**
 * Ids are decided by a pass over the whole list, not by `normalizeCommand`:
 * uniqueness is a property of the list, and the strict parser reuses the same
 * entry normalizer.
 *
 * Every claim is reserved before anything is minted. Minting in one forward
 * pass would let an id-less entry take the id a later entry claims and push the
 * claim's owner onto a different one — the same silent adoption of another
 * shortcut's override entries as a claimed shipped id, arriving from a sibling
 * instead of from the registry, and turning on nothing but the order of the
 * file. Between two entries claiming the same id the first still wins; the
 * second is minted over, because one id naming two shortcuts is the thing all
 * of this exists to prevent.
 */
function assignCustomIds(entries: CustomEntry[], strict: boolean): Command[] {
  const claims = entries.map((entry) => claimedId(entry, strict));
  // Seeded with the claims, so a mint cannot land on one that is still owed.
  const taken = new Set(claims.filter(isUserId));
  const handedOut = new Set<string>();
  return entries.map((entry, index) => {
    const claim = claims[index];
    const id =
      isUserId(claim) && !handedOut.has(claim) ? claim : mintUserId(entry.cmd.keys[0], taken);
    taken.add(id);
    handedOut.add(id);
    return { ...entry.cmd, id };
  });
}

/**
 * The id an entry asks for, or `''` when it asks for nothing usable.
 *
 * A claim is honoured only when it is a USER id. An id without the `u:` prefix
 * names a shipped shortcut — this build's or a later one's — and a command
 * wearing it would inherit that shortcut's override entries, which is the same
 * threat as the `builtin: true` claim `normalizeCommand` strips. The lenient
 * path mints a fresh id over it; the import parser refuses the file, because a
 * human is standing there and the fix is one line of their JSON. That refusal
 * covers every written id it cannot honour, malformed ones included: re-minting
 * an id the user typed and importing clean would hide the edit that needs
 * making. The two refusals say different things, because "use the `u:`
 * namespace" is no help to someone who already did and misspelled it.
 */
function claimedId({ cmd, raw }: CustomEntry, strict: boolean): string {
  const source = asRecord(raw)?.id;
  // A non-string is not a claim but a type error, and the lenient reader has
  // always forgiven those; there is no id in it to honour or to refuse.
  const written = typeof source === 'string' ? source.trim() : '';
  if (!written) return '';
  const claimed = normalizeId(written);
  if (isUserId(claimed)) return claimed;
  if (strict) {
    throw new Error(
      written.toLowerCase().startsWith(USER_ID_PREFIX)
        ? `Shortcut "${cmd.keys[0]}" has an "id" BunnyLol cannot use: "${written}" contains whitespace or is longer than ${MAX_ID_LENGTH} characters. Remove its "id" field.`
        : `Shortcut "${cmd.keys[0]}" claims the id "${written}", which is reserved for shipped shortcuts — your own shortcuts have ids starting with "${USER_ID_PREFIX}". Remove its "id" field.`,
    );
  }
  return '';
}

/** Returns null when the entry has no usable keyword or destination. */
function normalizeCommand(raw: unknown, known: Set<string>): Command | null {
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
    category: normalizeCategory(source.category, known),
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

/**
 * Narrows an open category id against the sections that actually exist.
 *
 * Exported so the options form narrows a `Draft.category` the same way a stored
 * blob is narrowed: an id no section answers to files under "My shortcuts",
 * which is the one group that is always there.
 */
export function normalizeCategory(raw: unknown, known: Set<string>): string {
  const value = trimmed(raw).toLowerCase();
  return known.has(value) ? value : FALLBACK_SECTION;
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
    throw new Error('"disabled" must be an array of shortcut ids.');
  }
  if (source.deleted !== undefined && !Array.isArray(source.deleted)) {
    throw new Error('"deleted" must be an array of shortcut ids.');
  }
  if (source.keyOverrides !== undefined && !asRecord(source.keyOverrides)) {
    throw new Error('"keyOverrides" must be an object mapping a keyword to its replacements.');
  }
  if (source.edits !== undefined && !asRecord(source.edits)) {
    throw new Error('"edits" must be an object mapping a shortcut id to the fields it changes.');
  }
  if (source.sections !== undefined && !Array.isArray(source.sections)) {
    throw new Error('"sections" must be an array of {id, label} objects.');
  }
  if (source.custom !== undefined && !Array.isArray(source.custom)) {
    throw new Error('"custom" must be an array of shortcuts.');
  }
  const pick = source.enabledCategories;
  if (pick !== undefined && pick !== null && !Array.isArray(pick)) {
    throw new Error('"enabledCategories" must be an array of category ids.');
  }
  if (source.seenBuiltins !== undefined && !Array.isArray(source.seenBuiltins)) {
    throw new Error('"seenBuiltins" must be an array of shortcut ids.');
  }
  // Sections before commands, for the reason in `normalizeOverrides`: a
  // category is resolved against the sections declared in the SAME file, so a
  // file that carries its own group is self-contained.
  const sections = parseSections(source.sections);
  const known = knownCategoryIds(sections);
  const custom: Command[] = assignCustomIds(
    (Array.isArray(source.custom) ? source.custom : []).map((entry: unknown, index: number) => ({
      cmd: parseCustomCommand(entry, index, known),
      raw: entry,
    })),
    true,
  );
  return {
    // `disabled` and `deleted` stay lenient: their entries name shortcuts the
    // user turned off or removed, so an unmatchable one costs nothing but a
    // dead line in the file. `deleted` is pruned for the reason in
    // `SHIPPED_IDS`, and pruning here too keeps import and export agreeing on
    // what the file means.
    disabled: normalizeIdList(source.disabled),
    deleted: normalizeIdList(source.deleted).filter((id) => SHIPPED_IDS.has(id)),
    edits: foldLegacyKeyOverrides(parseEdits(source.edits, known), parseKeyOverrides(source.keyOverrides)),
    sections,
    custom,
    // Lenient like `disabled`: an id this build does not ship is a pack that
    // went away, and dropping it costs nothing the user can see.
    enabledCategories: normalizeCategoryPick(source.enabledCategories),
    // Pruned like `deleted`, for the reason in `normalizeOverrides`.
    seenBuiltins: normalizeIdList(source.seenBuiltins).filter((id) => SHIPPED_IDS.has(id)),
  };
}

/**
 * Strict counterpart to `normalizeEdits`. Only the fields whose silence is
 * fatal are refused — a rebinding to `"foo bar"` never matches anything, and a
 * destination that is not a URL cannot be opened. The rest degrade exactly as
 * they do on the stored path, `category` included (see `parseCategory`).
 */
function parseEdits(raw: unknown, known: Set<string>): Record<string, ShortcutEdit> {
  const source = asRecord(raw);
  // Null-prototype: the keys come straight off untrusted JSON, and
  // `out['__proto__']` on a plain object would be swallowed by the setter it
  // inherits rather than stored as an edit.
  const out: Record<string, ShortcutEdit> = Object.create(null);
  const seen = new Set<string>();
  if (!source) return out;
  for (const [key, value] of Object.entries(source)) {
    // A blank key carries no instruction at all; only a key that says something
    // unusable is worth refusing the file over.
    if (!key.trim()) continue;
    const id = normalizeId(key);
    if (!id) {
      throw new Error(
        `"edits" has a shortcut id BunnyLol cannot use ("${key.trim()}") — an id has no spaces and is at most ${MAX_ID_LENGTH} characters.`,
      );
    }
    // Edits are for shipped shortcuts; a `u:` entry is dropped rather than
    // refused, because it is inert rather than wrong. Dropped BEFORE its fields
    // are checked, or an entry we were never going to read could still refuse
    // the whole file.
    if (isUserId(id)) continue;
    // Two keys that normalize to one id are two answers to the same question,
    // and taking the last one silently applies an edit the user cannot see in
    // their file.
    if (seen.has(id)) {
      throw new Error(
        `"edits" names the shortcut "${id}" twice (ids are compared lowercased), so BunnyLol cannot tell which edit you meant.`,
      );
    }
    seen.add(id);
    const entry = asRecord(value);
    if (!entry) {
      throw new Error(`"edits.${id}" must be an object of the fields the edit changes.`);
    }
    if (entry.keys !== undefined && !Array.isArray(entry.keys)) {
      throw new Error(`"edits.${id}.keys" must be an array of replacement keywords.`);
    }
    if (Array.isArray(entry.keys)) parseAliasList(entry.keys, `"edits.${id}.keys"`);
    parseEditUrl(entry.url, `"edits.${id}.url"`);
    parseEditUrl(entry.searchUrl, `"edits.${id}.searchUrl"`);
    parseCategory(entry.category, `"edits.${id}.category"`);
    const edit = normalizeEdit(entry, known);
    if (edit) out[id] = edit;
  }
  return out;
}

/**
 * A category is the one field the strict path degrades exactly like the lenient
 * one: an id no section answers to files a custom command under
 * `FALLBACK_SECTION` and is dropped from an edit (invariant 17), and the file
 * is not refused for it.
 *
 * Refusing it was tried and is wrong. Every v1.0.0 export whose custom shortcut
 * was filed under `media` — a category this build no longer ships — would be
 * unimportable, and the fix asked of the user is to hand-edit JSON they did not
 * write. A section a file does not declare costs the user a shortcut in the
 * wrong group, which the options page shows them and lets them fix in a click.
 *
 * The shape is still structural: a `category` that is not a string is a file
 * that means something this reader cannot guess at, and the id it names cannot
 * be reported back.
 */
function parseCategory(value: unknown, label: string): void {
  if (value === undefined || value === null || typeof value === 'string') return;
  throw new Error(`${label} must be a string naming a section.`);
}

/** `null` is "the user cleared this" and absent is "inherit"; only a written
 *  destination is checked. */
function parseEditUrl(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  const url = trimmed(value);
  if (!url) return;
  const check = validateUrlTemplate(url);
  if (!check.ok) throw new Error(`${label} BunnyLol will not open: it ${check.reason}.`);
}

/** Strict counterpart to `normalizeSections`. A section whose id is not a slug
 *  is a group nothing can ever be filed under. */
function parseSections(raw: unknown): Section[] {
  if (!Array.isArray(raw)) return [];
  // Refused rather than truncated: dropping the tail of a file the user chose
  // to import loses sections silently, and every category filed under one of
  // them would land back in "My shortcuts" with no explanation.
  if (raw.length > MAX_SECTIONS) {
    throw new Error(
      `"sections" has ${raw.length} entries — BunnyLol keeps at most ${MAX_SECTIONS}.`,
    );
  }
  for (const entry of raw) {
    const source = asRecord(entry);
    if (!source) throw new Error('"sections" has an entry that is not a JSON object.');
    const id = validateSectionId(trimmed(source.id));
    if (!id.ok) throw new Error(`"sections" has an id that ${id.reason}.`);
    const label = validateSectionLabel(typeof source.label === 'string' ? source.label : '');
    if (!label.ok) throw new Error(`"sections.${id.id}.label" ${label.reason}.`);
  }
  return normalizeSections(raw);
}

/**
 * Strict counterpart to `normalizeKeyOverrides`, and THE v1 export reader: a
 * format-1 file has its rebindings here and nowhere else, so this runs on every
 * import and its result is folded into `edits` (see `EXPORT_VERSION`).
 *
 * A rebinding to `"foo bar"` is the same silent death as a custom command with
 * a space in its keyword — the user rebinds `gh`, sees the file import cleanly,
 * and their keyword answers to nothing.
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
function parseCustomCommand(raw: unknown, index: number, known: Set<string>): Command {
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

  parseCategory(source.category, `The "category" of shortcut "${keys[0]}"`);

  const cmd = normalizeCommand(source, known);
  // Unreachable while the checks above mirror `normalizeCommand`'s two bail-outs
  // — kept so the strict and lenient paths cannot silently drift apart into an
  // import that returns nothing and says nothing.
  if (!cmd) throw new Error(`Shortcut "${keys[0]}" points at a URL BunnyLol will not open.`);
  return cmd;
}

function looksLikeOverrides(root: Record<string, unknown>): boolean {
  return (
    'custom' in root ||
    'disabled' in root ||
    'deleted' in root ||
    'edits' in root ||
    'sections' in root ||
    'enabledCategories' in root ||
    'seenBuiltins' in root ||
    // Format 1's name for `edits`, so a bare v1 snippet is still recognized.
    'keyOverrides' in root
  );
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
