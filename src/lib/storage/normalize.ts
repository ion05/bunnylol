/**
 * The LENIENT reader: everything that turns a blob of unknown provenance into a
 * `StoredState` this build can use.
 *
 * NOTHING HERE THROWS. Every function recovers what it can and drops what it
 * cannot: a field of the wrong type falls back to its default, an alias the
 * resolver could never match is dropped, a custom shortcut with no keyword or
 * no destination vanishes, and an unknown category degrades per invariant 17
 * (to `FALLBACK_SECTION` on a custom command, dropped from an edit). It runs on
 * the navigation path, where the caller is `chrome.storage.local` or a
 * `storage.onChanged` event and there is no human to read a message, so a
 * half-finished write or a blob from a future build has to leave every surface
 * navigable rather than blank the page.
 *
 * Its strict twin is `storage/parse-import.ts`, which reads the same shapes off
 * a file a human chose to import and refuses them by name instead. That
 * difference is the whole reason the two families are separate files; the
 * strict one calls in here for the parts that degrade on both paths.
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
} from '../types';
import {
  CATEGORIES,
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  DEFAULT_STOP_LIST,
  FALLBACK_SECTION,
} from '../types';
import { SEARCH_ENGINES } from '../commands';
import {
  MAX_SECTIONS,
  foldLegacyKeyOverrides,
  isUserId,
  knownCategoryIds,
  normalizeId,
} from '../overrides';
import { clone } from '../text';
import { validateAlias, validateSectionId, validateSectionLabel } from '../validate';
import { SHIPPED_IDS, asRecord, assignCustomIds, safeUrl, trimmed } from './shared';
import type { CustomEntry } from './shared';

const ENGINE_IDS = new Set<string>(SEARCH_ENGINES.map((engine) => engine.id));

// ------------------------------------------------------------------- state ----

export function normalizeState(raw: unknown): StoredState {
  const source = asRecord(raw);
  return {
    overrides: normalizeOverrides(source?.overrides),
    settings: normalizeSettings(source?.settings),
  };
}

// ---------------------------------------------------------------- settings ----

/**
 * Stored settings are merged field by field on top of `DEFAULT_SETTINGS`, so a
 * field added in a later build is never `undefined` on an old profile.
 */
export function normalizeSettings(raw: unknown): Settings {
  const source = asRecord(raw);
  if (!source) return clone(DEFAULT_SETTINGS);
  return {
    githubUser: trimmed(source.githubUser),
    defaultEngine: safeUrl(source.defaultEngine) || DEFAULT_SETTINGS.defaultEngine,
    interceptEngines: normalizeEngines(source.interceptEngines),
    aiTemplates: normalizeTemplates(source.aiTemplates),
    googleAccount: normalizeAccount(source.googleAccount),
    interceptStopList: normalizeStopList(source.interceptStopList),
    dispatchToast: source.dispatchToast === true,
  };
}

/**
 * The exemption list. Missing means "never configured" and gets the shipped
 * default, which is empty: every registered keyword is intercepted until the
 * user exempts one by name.
 */
function normalizeStopList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_STOP_LIST];
  return normalizeAliases(raw);
}

function normalizeEngines(raw: unknown): SearchEngineId[] {
  // Missing means "never configured" and gets the defaults; an empty array is a
  // real choice: the user turned interception off entirely.
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
  // Null-prototype, like every other override map the parser builds. A string
  // assigned to `__proto__` on a plain object is swallowed by the inherited
  // setter rather than stored, so this map was the one place a key could go
  // missing without the parser saying so.
  const templates: Record<string, string> = Object.create(null) as Record<string, string>;
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

// --------------------------------------------------------------- overrides ----

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
export function normalizeCategoryPick(raw: unknown): string[] | null {
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
export function normalizeIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    const id = normalizeId(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// ------------------------------------------------------------------- edits ----

/**
 * The edit layer, field by field. Never reads `handler`, `provider`, `builtin`
 * or `id`: an edit that names them is not a shortcut definition, it is an
 * attempt to become one (invariant 16).
 *
 * An entry that ends up with no fields is dropped entirely, so "reset to
 * shipped" is representable as the absence of an entry and the stored blob
 * stays canonical.
 */
function normalizeEdits(raw: unknown, known: Set<string>): Record<string, ShortcutEdit> {
  const source = asRecord(raw);
  // Null-prototype: see `parseEdits`. A stored blob is untrusted for the same
  // reason a file is: it is where an import file ends up.
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
export function normalizeEdit(
  source: Record<string, unknown>,
  known: Set<string>,
): ShortcutEdit | null {
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
  // other category to fall back to, but a shipped one does, its own, and
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

// ---------------------------------------------------------------- sections ----

/** Sections are data here; the algebra that resolves a command's category
 *  against them lands with the section editor. */
export function normalizeSections(raw: unknown): Section[] {
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

// --------------------------------------------------------- custom commands ----

function normalizeCustom(raw: unknown, known: Set<string>): Command[] {
  if (!Array.isArray(raw)) return [];
  const entries: CustomEntry[] = [];
  for (const entry of raw) {
    const cmd = normalizeCommand(entry, known);
    if (cmd) entries.push({ cmd, raw: entry });
  }
  return assignCustomIds(entries, false);
}

/** Returns null when the entry has no usable keyword or destination. */
export function normalizeCommand(raw: unknown, known: Set<string>): Command | null {
  const source = asRecord(raw);
  if (!source) return null;
  const keys = normalizeAliases(source.keys);
  const url = safeUrl(source.url);
  // The lead alias stands in for `keys.length === 0`: same test, and it is the
  // one the unnamed fallback below needs to be present.
  const lead = keys[0];
  if (lead === undefined || !url) return null;

  const cmd: Command = {
    keys,
    name: trimmed(source.name) || lead,
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
