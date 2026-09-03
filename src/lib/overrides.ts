/**
 * Shortcut identity and the edit algebra: the one answer to "which shortcut is
 * this?", and the one place that says what an override may change about it.
 *
 * Pure: it imports the contract and the validation boundary and nothing else,
 * so `resolve.ts`, `storage.ts` and the options page can all depend on it
 * without a cycle.
 *
 * A shortcut is a shortcut: a shipped one and a user-created one are the same
 * kind of thing, and both need a name the override maps can be keyed by. Aliases
 * cannot be that name, because rebinding `gh` to `hub` would otherwise orphan
 * every entry that referred to it. So a shipped command is identified by its
 * SHIPPED `keys[0]`. The registry is code, so that string never moves. A
 * user-created one gets a generated `u:`-prefixed id that survives key edits.
 *
 * On top of that identity sits the algebra: `applyEdit` folds a stored
 * `ShortcutEdit` onto a shipped command, `diffEdit` produces one from an edited
 * copy, and `foldLegacyKeyOverrides` migrates the v1 `keyOverrides` map into
 * it. A DIFF, not a copy: a corrected URL in a later build still reaches a user
 * who only renamed the command.
 *
 * The section algebra sits here for the same reason: a category is now an open
 * id resolved against `Overrides.sections`, so "which group is this shortcut
 * in, and what is that group called" is a question storage, the resolver and
 * the options page all ask, and all three have to get the same answer.
 */

import type { Command, Overrides, Section, ShortcutEdit } from './types';
import { CATEGORIES, CATEGORY_LABELS, FALLBACK_SECTION } from './types';
import {
  MAX_KEYWORD_LENGTH,
  MAX_SECTION_ID_LENGTH,
  validateAlias,
  validateSectionLabel,
  validateUrlTemplate,
} from './validate';

/**
 * Marks an id as belonging to a user-created shortcut, and is what makes
 * minting collision-free: only minting can put a shortcut in this namespace.
 * `shortcutId` enforces that: an alias may legally contain a `:`
 * (`validateAlias` does not reject one), so the keys fallback refuses to adopt
 * a `u:`-looking keyword as an id. The only way past it is a builtin that
 * authors `id` itself, which `commands.ts` never does and the registry sweep in
 * `tests/overrides.test.ts` fails on.
 */
export const USER_ID_PREFIX = 'u:';

/**
 * Derived, not restated: a shipped id IS a shipped key, so a cap below the one
 * `validateAlias` enforces would strip the identity off any command whose
 * canonical key sat between the two.
 */
export const MAX_ID_LENGTH = MAX_KEYWORD_LENGTH;

/**
 * Everything a minted slug may keep; anything else collapses to `-`. Narrower
 * than `SAFE_KEYWORD` on purpose: dashes only, so a minted id is also a
 * `validateSectionId`-shaped slug once the prefix is dropped, and every
 * generated identity in the extension is written one way.
 */
const SLUG_UNSAFE = /[^a-z0-9-]+/g;

const DASH_RUN = /-{2,}/g;

const EDGE_DASH = /^-+|-+$/g;

/** Used when the seed has no usable character at all (`"…"`, `"!!!"`). */
const FALLBACK_SLUG = 'shortcut';

/**
 * Reads an id off untrusted data: trimmed and lowercased, or `''` when the
 * value could not be an id at all: a non-string, one with whitespace in it,
 * one past the length cap. A hand-edited file cannot key an override map with
 * something the resolver could never look up again.
 *
 * It deliberately does NOT also require the mint alphabet: a shipped id is a
 * shipped key, and one of those is `?`, so an alphabet check here would leave
 * that command with no identity at all. Adoption of a *claimed* id is narrowed
 * to the `u:` namespace at the storage boundary instead, where the claim is.
 */
export function normalizeId(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const id = raw.trim().toLowerCase();
  if (!id || /\s/.test(id) || id.length > MAX_ID_LENGTH) return '';
  return id;
}

/**
 * The one answer to "which shortcut is this?". Falls back to the canonical
 * alias, so a command that predates ids still has an identity without a
 * migration. That covers every builtin, and every custom command in a v1 blob.
 */
export function shortcutId(cmd: Command): string {
  const id = normalizeId(cmd?.id);
  if (id) return id;
  // A keyword may contain a `:`, so a command keyed `u:tix` would otherwise
  // fall back into the namespace only minting is allowed to fill, and share an
  // id with whatever storage did mint for it. It has no identity until storage
  // gives it one, and saying so is better than inventing a colliding answer.
  const key = normalizeId(cmd?.keys?.[0]);
  return isUserId(key) ? '' : key;
}

export function isUserId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(USER_ID_PREFIX);
}

/**
 * The alias a command leads with. Deliberately not `shortcutId`: its callers
 * key maps by what the user types, and a custom shortcut's id is a `u:` slug
 * that answers to nothing in the address bar.
 */
export function firstKey(cmd: Command): string {
  return (cmd?.keys?.[0] ?? '').trim().toLowerCase();
}

/**
 * Mints an id for a user-created shortcut, deterministically: same seed and
 * same `taken` set, same id, in any build and on any machine. No randomness and
 * no clock, because two imports of the same file must agree on what they named
 * the shortcut, and a test must be able to state the answer.
 */
export function mintUserId(seed: string, taken: Set<string>): string {
  const slug = slugify(seed);
  let candidate = USER_ID_PREFIX + fit(slug, '');
  for (let n = 2; taken.has(candidate); n += 1) {
    const suffix = `-${n}`;
    candidate = USER_ID_PREFIX + fit(slug, suffix) + suffix;
  }
  return candidate;
}

function slugify(seed: string): string {
  const slug = (typeof seed === 'string' ? seed : '')
    .toLowerCase()
    .replace(SLUG_UNSAFE, '-')
    .replace(DASH_RUN, '-')
    .replace(EDGE_DASH, '');
  return slug || FALLBACK_SLUG;
}

/** Trims the slug so prefix + slug + suffix stays inside `MAX_ID_LENGTH`. */
function fit(slug: string, suffix: string): string {
  const room = MAX_ID_LENGTH - USER_ID_PREFIX.length - suffix.length;
  // A truncation that lands mid-word must not leave a trailing `-`, or the id
  // reads as `u:my-shortcut--2`.
  const cut = slug.slice(0, room).replace(EDGE_DASH, '');
  return cut || FALLBACK_SLUG.slice(0, room);
}

// ------------------------------------------------------------ edit algebra ----

/**
 * Folds a stored edit onto a shipped command, without mutating either.
 *
 * SECURITY: `handler`, `provider`, `builtin` and `id` are never read from
 * `edit`: the fields are copied one at a time instead of spreading, so an
 * import file that invents them changes nothing (invariant 16). Do not add
 * `next.handler = cmd.handler` "for clarity": it would put an
 * `undefined`-valued key on every merged command.
 *
 * Absent is "inherit" everywhere, so a half-written edit degrades to the
 * shipped definition rather than to a broken command.
 *
 * `known` is the set of section ids this profile has (`knownCategoryIds`).
 * Omitting it means the builtin categories and nothing else, which is what a
 * caller with no `Overrides` in hand can honestly say.
 */
export function applyEdit(
  cmd: Command,
  edit: ShortcutEdit | undefined,
  known: ReadonlySet<string> = BUILTIN_CATEGORY_IDS,
): Command {
  if (!edit) return cmd;
  const next: Command = { ...cmd };

  const keys = aliasList(edit.keys);
  // An empty list means "no override", not "no aliases": otherwise a
  // half-finished rebind in the options page, or a file whose replacements are
  // all unusable, orphans the command entirely.
  if (keys.length > 0) next.keys = keys;

  const name = text(edit.name);
  if (name) next.name = name;

  // The one field an edit may blank: a description is decoration, and someone
  // who clears it means it. A blank name would leave an unlabelled row.
  if (typeof edit.description === 'string') next.description = edit.description.trim();

  // Validated rather than merely non-blank: `rawDestination` hands `cmd.url`
  // straight to the navigation, and prose is not a destination. A blank or
  // unparseable url inherits the shipped one (invariant 12).
  const url = text(edit.url);
  if (url && validateUrlTemplate(url).ok) next.url = url;

  if (edit.searchUrl === null) delete next.searchUrl;
  else {
    const searchUrl = text(edit.searchUrl);
    if (searchUrl && validateUrlTemplate(searchUrl).ok) next.searchUrl = searchUrl;
  }

  if (edit.example === null) delete next.example;
  else {
    const example = text(edit.example);
    if (example) next.example = example;
  }

  // An id no section answers to is dropped, not coerced to `custom`: a shipped
  // command must not be silently relocated to "My shortcuts" because the file
  // named a section that is not here.
  const category = text(edit.category).toLowerCase();
  if (known.has(category)) next.category = category;

  return next;
}

/**
 * The inverse: what would have to be stored for `applyEdit(shipped, …)` to
 * produce `next`. `null` when nothing differs, so "reset to shipped" is
 * representable as the absence of an entry rather than as an empty object.
 *
 * A change `applyEdit` could not carry back, such as a blanked name or a url
 * that is not a URL, is reported as no change, because storing it would produce
 * a diff that does not round trip.
 */
export function diffEdit(
  shipped: Command,
  next: Command,
  known: ReadonlySet<string> = BUILTIN_CATEGORY_IDS,
): ShortcutEdit | null {
  const edit: ShortcutEdit = {};

  const keys = aliasList(next?.keys);
  if (keys.length > 0 && !sameKeys(keys, aliasList(shipped?.keys))) edit.keys = keys;

  const name = text(next?.name);
  if (name && name !== text(shipped?.name)) edit.name = name;

  const description = text(next?.description);
  if (description !== text(shipped?.description)) edit.description = description;

  const url = text(next?.url);
  if (url && url !== text(shipped?.url) && validateUrlTemplate(url).ok) edit.url = url;

  // `null` and "absent" are different instructions: absent inherits the shipped
  // searchUrl, null says the user removed it. So the two ways a field can end
  // up unset are NOT the same answer here: a blank one is a removal, while one
  // `applyEdit` would refuse to apply is no change at all, and recording it as
  // `null` would delete a searchUrl the user never touched.
  const searchUrl = text(next?.searchUrl);
  const shippedSearch = text(shipped?.searchUrl);
  if (!searchUrl) {
    if (shippedSearch) edit.searchUrl = null;
  } else if (searchUrl !== shippedSearch && validateUrlTemplate(searchUrl).ok) {
    edit.searchUrl = searchUrl;
  }

  const category = text(next?.category).toLowerCase();
  if (known.has(category) && category !== text(shipped?.category).toLowerCase()) {
    edit.category = category;
  }

  // Same shape, minus the validation: an example is prose, so there is no such
  // thing as one `applyEdit` would refuse.
  const example = text(next?.example);
  const shippedExample = text(shipped?.example);
  if (!example) {
    if (shippedExample) edit.example = null;
  } else if (example !== shippedExample) {
    edit.example = example;
  }

  return Object.keys(edit).length > 0 ? edit : null;
}

/**
 * The v1 reader for rebinding. Format 1 stored replacement aliases in their own
 * `Overrides.keyOverrides` map; format 2 has one writer for `keys`, the edit
 * layer, because two of them is exactly the drift that lets a rebind persist in
 * one place and be read from the other.
 *
 * Exported from here rather than hidden in storage so the lenient path and the
 * strict import parser fold identically: a v1 export file and a v1 stored blob
 * are the same migration.
 */
export function foldLegacyKeyOverrides(
  edits: Record<string, ShortcutEdit>,
  legacy: Record<string, string[]>,
): Record<string, ShortcutEdit> {
  // Null-prototype: an id is a key off untrusted JSON, and `out['__proto__']`
  // on a plain object would be swallowed by the inherited setter.
  const out: Record<string, ShortcutEdit> = Object.assign(Object.create(null), edits);
  for (const [key, list] of Object.entries(legacy ?? {})) {
    const id = normalizeId(key);
    const keys = aliasList(list);
    // The legacy map predates user ids, so a `u:` key in one is a hand edit,
    // and edits are for shipped shortcuts (a custom command is edited in
    // place). Folding it would reintroduce exactly the entry `normalizeEdits`
    // drops.
    if (!id || isUserId(id) || keys.length === 0) continue;
    // An explicit edit is the current format's answer and wins; the legacy map
    // only fills a gap it left.
    if (out[id]?.keys?.length) continue;
    out[id] = { ...out[id], keys };
  }
  return out;
}

// --------------------------------------------------------- section algebra ----

/**
 * The ids that name a shipped group. Precomputed because `applyEdit` runs once
 * per builtin on every merge, and the default answer must not allocate a set
 * each time.
 */
const BUILTIN_CATEGORY_IDS: ReadonlySet<string> = new Set<string>(CATEGORIES);

/**
 * An import file may not fill the browse list with junk sections. Lives here
 * rather than in storage because `addSection` has to refuse at the same number
 * the storage boundary would silently truncate at.
 */
export const MAX_SECTIONS = 64;

/** Prefixed so a minted id can never collide with a builtin category id, which
 *  is what makes "rename a shipped group" and "create a group" different acts
 *  on the same list. */
const SECTION_ID_PREFIX = 'sec-';

/** Every id a command may legally be filed under: the shipped groups, plus the
 *  sections this profile declares. */
export function knownCategoryIds(sections: Section[] | undefined): Set<string> {
  const known = new Set<string>(CATEGORIES);
  for (const section of sections ?? []) {
    const id = sectionKey(section?.id);
    if (id) known.add(id);
  }
  return known;
}

/**
 * What a section id is called on screen. A `sections` entry wins, that is how
 * a shipped group gets renamed, then the shipped label, then the id itself, so
 * a group whose section entry vanished still has a heading instead of an empty
 * one.
 */
export function sectionLabel(id: string, sections: Section[] | undefined): string {
  const key = sectionKey(id);
  if (!key) return '';
  for (const section of sections ?? []) {
    if (sectionKey(section?.id) === key) {
      const label = validateSectionLabel(section?.label ?? '');
      if (label.ok) return label.label;
    }
  }
  // `Object.hasOwn`, not `CATEGORY_LABELS[key]`: `key` is an open id off
  // untrusted data and `validateSectionId` accepts `constructor`, so a plain
  // lookup would answer with something off `Object.prototype`.
  if (Object.hasOwn(CATEGORY_LABELS, key)) return CATEGORY_LABELS[key as keyof typeof CATEGORY_LABELS];
  return key;
}

export function isShippedSection(id: string): boolean {
  return BUILTIN_CATEGORY_IDS.has(sectionKey(id));
}

/**
 * The order the browse list shows its groups in. Callers still drop the empty
 * ones, so this is the full order rather than the visible one.
 *
 * The user's own shortcuts lead: they are the reason this page exists, and they
 * are the ones that need editing. Then the shipped groups in registry order,
 * then the user's own sections in the order they created them, and last the
 * strays: an id some command still names that no section declares, which would
 * otherwise be a group of shortcuts with nowhere to be drawn.
 */
export function sectionOrder(sections: Section[] | undefined, commands: Command[]): string[] {
  const used = new Set<string>();
  for (const cmd of commands ?? []) {
    const id = sectionKey(cmd?.category);
    if (id) used.add(id);
  }

  const order: string[] = [];
  if (used.has(FALLBACK_SECTION)) order.push(FALLBACK_SECTION);
  for (const category of CATEGORIES) {
    if (category !== FALLBACK_SECTION) order.push(category);
  }
  const listed = new Set(order);
  for (const section of sections ?? []) {
    const id = sectionKey(section?.id);
    if (id && !listed.has(id)) {
      listed.add(id);
      order.push(id);
    }
  }
  for (const id of used) {
    if (!listed.has(id)) {
      listed.add(id);
      order.push(id);
    }
  }
  return order;
}

/**
 * The section picker's options, in browse order. `custom` is always offered
 * even when it holds nothing: it is where a new shortcut goes and the one group
 * that cannot be deleted.
 */
export function sectionOptions(sections: Section[] | undefined, commands: Command[]): Section[] {
  const order = sectionOrder(sections, commands);
  const ids = order.includes(FALLBACK_SECTION) ? order : [FALLBACK_SECTION, ...order];
  return ids.map((id) => ({ id, label: sectionLabel(id, sections) }));
}

/**
 * The ids of the shortcuts filed under a section right now: what "delete this
 * section" has to warn about.
 *
 * Edits applied, because a shipped command the user moved is in the section
 * they moved it to and not in the one the registry ships it under. A shortcut
 * the user turned off still counts (it is listed, greyed, in that group); a
 * deleted shipped one does not, because no surface draws it.
 */
export function sectionMembers(id: string, builtins: Command[], overrides: Overrides): string[] {
  const key = sectionKey(id);
  if (!key) return [];
  const known = knownCategoryIds(overrides?.sections);
  const deleted = new Set((overrides?.deleted ?? []).map(normalizeId).filter(Boolean));
  const edits = overrides?.edits ?? {};
  const members: string[] = [];

  for (const cmd of overrides?.custom ?? []) {
    const cmdId = shortcutId(cmd);
    if (cmdId && sectionKey(cmd?.category) === key) members.push(cmdId);
  }
  for (const cmd of builtins ?? []) {
    const cmdId = shortcutId(cmd);
    if (!cmdId || deleted.has(cmdId)) continue;
    if (sectionKey(applyEdit(cmd, edits[cmdId], known).category) === key) members.push(cmdId);
  }
  return members;
}

/**
 * A section id minted from its label, deterministically: same label and same
 * `taken` set, same id. `sec-`-prefixed so it can never land on a builtin
 * category id: an entry whose id is `dev` means "the shipped Developer group,
 * renamed", and a user's new section called "Dev" must not become that.
 */
export function newSectionId(label: string, taken: Set<string>): string {
  const slug = slugify(label);
  let candidate = fitSectionId(slug, '', SECTION_ID_PREFIX);
  for (let n = 2; taken.has(candidate); n += 1) {
    candidate = fitSectionId(slug, `-${n}`, SECTION_ID_PREFIX);
  }
  return candidate;
}

/**
 * `fit` for section ids: `prefix + base + suffix`, with `base` cut so the whole
 * thing stays inside `MAX_SECTION_ID_LENGTH`.
 *
 * Exported because the import merge suffixes ids too, and an id that overshoots
 * the cap is one `validateSectionId` rejects and the next save silently drops:
 * taking every shortcut filed under it back to "My shortcuts".
 */
export function fitSectionId(base: string, suffix = '', prefix = ''): string {
  const room = MAX_SECTION_ID_LENGTH - prefix.length - suffix.length;
  // A truncation that lands mid-word must not leave a trailing `-`, or the id
  // reads as `sec-client-work--2`.
  const cut = base.slice(0, room).replace(EDGE_DASH, '');
  return prefix + (cut || FALLBACK_SLUG.slice(0, room)) + suffix;
}

/**
 * Whether a section already goes by this name, case-insensitively, two groups
 * with one heading between them is a list the user cannot navigate.
 *
 * Asked of the labels in EFFECT, not of `CATEGORY_LABELS` as shipped: a user
 * who renamed "Developer" to "Engineering" has freed the word "Developer", and
 * refusing it would be refusing a name nothing on the page shows.
 *
 * `selfId` names the section being renamed, and turns the question into the one
 * a rename actually has to ask: does the list this rename WOULD PRODUCE show
 * one label twice? That is the only formulation that answers all three acts
 * with one rule: a section may keep its own name, and restoring a shipped
 * group's default name drops its entry so the id falls back to the shipped
 * label, which is free unless some other section has since taken it. Asking
 * instead "is this label in use, ignoring me" gets the restore case wrong in
 * both directions. Duplicate labels an import legitimately carried
 * (`mergeOverrides` keeps two ids with one label rather than merging them) are
 * tolerated: only a SECOND holder of the label being typed is a refusal.
 */
export function sectionLabelTaken(
  label: string,
  sections: Section[] | undefined,
  selfId?: string,
): boolean {
  const check = validateSectionLabel(label);
  const wanted = check.ok ? check.label : label;
  const folded = foldLabel(wanted);
  if (!folded) return false;

  const list = sections ?? [];
  const self = sectionKey(selfId);
  const next = self ? renamedSections(list, self, wanted) : list;

  const ids = new Set<string>(CATEGORIES);
  for (const section of next) {
    const id = sectionKey(section?.id);
    if (id) ids.add(id);
  }
  let holders = 0;
  for (const id of ids) {
    if (foldLabel(sectionLabel(id, next)) === folded) holders += 1;
  }
  // An add lands a NEW holder on that list, so one existing holder is already
  // the clash; a rename replaces its own holder, so the refusal is a second.
  return holders > (self ? 1 : 0);
}

/**
 * Adds a user section and says what it was called, so the caller can file the
 * shortcut it was creating it for. `id` is `''` when the label was unusable or
 * the profile is at `MAX_SECTIONS`: refused rather than added and silently
 * dropped by the storage boundary on the next save.
 */
export function addSection(overrides: Overrides, label: string): { overrides: Overrides; id: string } {
  const check = validateSectionLabel(label);
  const sections = overrides?.sections ?? [];
  if (!check.ok || sections.length >= MAX_SECTIONS) return { overrides, id: '' };
  // Seeded with the builtin ids too, so a mint can never produce one: belt and
  // braces behind `SECTION_ID_PREFIX`.
  const id = newSectionId(check.label, knownCategoryIds(sections));
  return {
    overrides: { ...overrides, sections: [...sections, { id, label: check.label }] },
    id,
  };
}

/**
 * Renames a section, or creates the entry that renames a shipped one.
 *
 * Renaming a shipped group BACK to its shipped label removes the entry instead
 * of storing a rename that changes nothing, so "undo the rename" leaves the
 * blob it started from rather than a permanent record of a round trip.
 *
 * Refuses past `MAX_SECTIONS` by returning its input UNCHANGED, for the same
 * reason `addSection` does: renaming a shipped group that has no entry yet
 * APPENDS one, and an appended entry over the cap is one the storage boundary
 * drops on the next save: leaving the heading back under its shipped name with
 * nothing on screen to say why.
 */
export function renameSection(overrides: Overrides, id: string, label: string): Overrides {
  const key = sectionKey(id);
  const check = validateSectionLabel(label);
  if (!key || !check.ok) return overrides;
  const sections = overrides?.sections ?? [];

  const next = renamedSections(sections, key, check.label);
  if (next.length > sections.length && sections.length >= MAX_SECTIONS) return overrides;
  // The rename-back of a shipped id that had no entry rewrites nothing, so the
  // blob it started from is what comes back rather than a fresh copy of itself.
  if (next.length === sections.length && next.every((section, n) => section === sections[n])) {
    return overrides;
  }
  return { ...overrides, sections: next };
}

/**
 * The section list a rename produces, without the surrounding `Overrides`:
 * shared with `sectionLabelTaken` so the clash check is asked of exactly the
 * list the save would write, and cannot drift from it.
 */
function renamedSections(sections: Section[], key: string, label: string): Section[] {
  if (isShippedSection(key) && label === CATEGORY_LABELS[key as keyof typeof CATEGORY_LABELS]) {
    return sections.filter((section) => sectionKey(section?.id) !== key);
  }
  const existing = sections.some((section) => sectionKey(section?.id) === key);
  return existing
    ? sections.map((section) => (sectionKey(section?.id) === key ? { id: key, label } : section))
    : [...sections, { id: key, label }];
}

/**
 * Deletes a user section and files everything that was in it under
 * `FALLBACK_SECTION`.
 *
 * Refuses a shipped id by returning its input UNCHANGED: a shipped group is
 * part of the registry and can only be renamed, and deleting it would leave
 * every command it holds pointing at a category no list draws.
 *
 * Members move in BOTH places, because a section can hold a user's own command
 * (`custom[].category`) and a shipped one they moved into it
 * (`edits[].category`), and leaving either behind orphans that shortcut.
 */
export function deleteSection(overrides: Overrides, id: string): Overrides {
  const key = sectionKey(id);
  if (!key || isShippedSection(key)) return overrides;
  const sections = overrides?.sections ?? [];
  if (!sections.some((section) => sectionKey(section?.id) === key)) return overrides;

  // Null-prototype: the ids are keys off an import file, and `edits['__proto__']`
  // on a plain object is swallowed by the setter it inherits.
  const edits: Record<string, ShortcutEdit> = Object.create(null);
  for (const [editId, edit] of Object.entries(overrides?.edits ?? {})) {
    edits[editId] =
      sectionKey(edit?.category) === key ? { ...edit, category: FALLBACK_SECTION } : edit;
  }

  return {
    ...overrides,
    edits,
    sections: sections.filter((section) => sectionKey(section?.id) !== key),
    custom: (overrides?.custom ?? []).map((cmd) =>
      sectionKey(cmd?.category) === key ? { ...cmd, category: FALLBACK_SECTION } : cmd,
    ),
  };
}

/**
 * Reads a section id off untrusted data. Shape only: `validateSectionId` is
 * the boundary that decides what may be STORED; this is how what is already
 * stored gets compared.
 *
 * Exported because the options page keys things by section id too, the folded
 * groups in `options/model/collapse.ts`, the rows in the Sections card, and a
 * private copy in each was already three spellings of one rule.
 */
export function sectionKey(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Labels compare case- and width-insensitively: "Work" and "work" are one
 * group with two spellings, and NFKC folds the full-width lookalikes that make
 * two headings render identically.
 *
 * Exported because the import merge asks the same question: a section it judges
 * a collision by a different rule than the section editor uses is a group the
 * user renamed here and the merge then split in two.
 */
export function foldLabel(label: string): string {
  return (typeof label === 'string' ? label : '').normalize('NFKC').trim().toLowerCase();
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The aliases a list can actually be matched by: through the one validation
 * boundary (invariant 6), lowercased and deduped like every other alias in the
 * extension. A rebinding to `"foo bar"` or `"\bad"` is unreachable on every
 * surface, so applying it would leave the shortcut answering to nothing.
 */
function aliasList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const aliases: string[] = [];
  for (const entry of raw) {
    const check = validateAlias(text(entry));
    if (check.ok && !aliases.includes(check.alias)) aliases.push(check.alias);
  }
  return aliases;
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, i) => key.toLowerCase() === b[i].toLowerCase());
}
