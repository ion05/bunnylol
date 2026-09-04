/**
 * The STRICT import parser: the reader for a file a human chose to import.
 *
 * IT THROWS, and the message names what is wrong ("sections" has an id that…,
 * Shortcut "gh" is missing its "url"). That is the whole difference from
 * `storage/normalize.ts`, which reads the same shapes off storage and recovers
 * silently: here someone is standing in the options page waiting to read the
 * message, and the fix is one line of their own JSON, so an import that quietly
 * drops half their shortcuts is worse than a refused one. Every `Error` raised
 * in this file is shown verbatim.
 *
 * It refuses only what silence would lose. Fields whose bad value costs nothing
 * a user can see still degrade, through the lenient functions this file calls:
 * `disabled`, `deleted`, `enabledCategories`, `seenBuiltins` and, deliberately,
 * `category` (invariant 17 and `parseCategory`, which document why refusing an
 * unknown section was tried and reverted).
 */

import type { Command, Overrides, Section, Settings, ShortcutEdit } from '../types';
import { DEFAULT_OVERRIDES } from '../types';
import {
  MAX_ID_LENGTH,
  MAX_SECTIONS,
  foldLegacyKeyOverrides,
  isUserId,
  knownCategoryIds,
  normalizeId,
} from '../overrides';
import { clone } from '../text';
import { validateAlias, validateSectionId, validateSectionLabel, validateUrlTemplate } from '../validate';
import { EXPORT_VERSION, SHIPPED_IDS, asRecord, assignCustomIds, trimmed } from './shared';
import {
  normalizeCategoryPick,
  normalizeCommand,
  normalizeEdit,
  normalizeIdList,
  normalizeSections,
  normalizeSettings,
} from './normalize';

// --------------------------------------------------------- the import file ----

/**
 * The result of reading an import file. `settings` is null when the file had no
 * "settings" key at all: a shortcuts-only snippet must not be mistaken for
 * "reset every setting to its default".
 */
export interface ImportedState {
  overrides: Overrides;
  settings: Settings | null;
}

/**
 * Parses an export file. Accepts a full `StoredState` or a bare `Overrides`
 * object, and throws an `Error` whose message is safe to show verbatim.
 */
export function importJson(text: string): ImportedState {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Nothing to import. The file is empty.');
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
    throw new Error('That file has no BunnyLol data in it. Expected "overrides" or "settings".');
  }

  return {
    overrides: parseOverrides(overrides),
    // Absent, not empty: `applyImport` keeps the user's current settings.
    settings: root.settings === undefined ? null : parseSettings(asRecord(root.settings) ?? {}),
  };
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

// ---------------------------------------------------------------- settings ----

/**
 * Strict counterpart to `normalizeSettings` for the URL-shaped fields only.
 *
 * A `defaultEngine` that is not a URL is the worst single value in the file:
 * it does not break one shortcut, it breaks every query that matches none,
 * because `toNavigableUrl` reads a scheme-less string as an extension-relative
 * path. Silently swapping it for the default would hide the user's typo, so
 * this is the one place settings refuse instead of degrade. Everything else is
 * still normalized away: an unknown engine id, a negative account index.
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

// --------------------------------------------------------------- overrides ----

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

// ------------------------------------------------------------------- edits ----

/**
 * Strict counterpart to `normalizeEdits`. Only the fields whose silence is
 * fatal are refused: a rebinding to `"foo bar"` never matches anything, and a
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
        `"edits" has a shortcut id BunnyLol cannot use ("${key.trim()}"). An id has no spaces and is at most ${MAX_ID_LENGTH} characters.`,
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
 * was filed under `media`, a category this build no longer ships, would be
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

// --------------------------------------------------- sections and keywords ----

/** Strict counterpart to `normalizeSections`. A section whose id is not a slug
 *  is a group nothing can ever be filed under. */
function parseSections(raw: unknown): Section[] {
  if (!Array.isArray(raw)) return [];
  // Refused rather than truncated: dropping the tail of a file the user chose
  // to import loses sections silently, and every category filed under one of
  // them would land back in "My shortcuts" with no explanation.
  if (raw.length > MAX_SECTIONS) {
    throw new Error(
      `"sections" has ${raw.length} entries. BunnyLol keeps at most ${MAX_SECTIONS}.`,
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
 * a space in its keyword: the user rebinds `gh`, sees the file import cleanly,
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

// --------------------------------------------------------- custom commands ----

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
    throw new Error(`${label} has no keyword. Every shortcut needs a "keys" list of strings.`);
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
  // Unreachable while the checks above mirror `normalizeCommand`'s two bail-outs,
  // kept so the strict and lenient paths cannot silently drift apart into an
  // import that returns nothing and says nothing.
  if (!cmd) throw new Error(`Shortcut "${keys[0]}" points at a URL BunnyLol will not open.`);
  return cmd;
}
