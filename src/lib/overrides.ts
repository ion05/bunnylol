/**
 * Shortcut identity and the edit algebra: the one answer to "which shortcut is
 * this?", and the one place that says what an override may change about it.
 *
 * Pure — it imports the contract and the validation boundary and nothing else,
 * so `resolve.ts`, `storage.ts` and the options page can all depend on it
 * without a cycle.
 *
 * A shortcut is a shortcut: a shipped one and a user-created one are the same
 * kind of thing, and both need a name the override maps can be keyed by. Aliases
 * cannot be that name, because rebinding `gh` to `hub` would otherwise orphan
 * every entry that referred to it. So a shipped command is identified by its
 * SHIPPED `keys[0]` — the registry is code, so that string never moves — and a
 * user-created one gets a generated `u:`-prefixed id that survives key edits.
 *
 * On top of that identity sits the algebra: `applyEdit` folds a stored
 * `ShortcutEdit` onto a shipped command, `diffEdit` produces one from an edited
 * copy, `editedFields` says what actually moved, `foldLegacyKeyOverrides`
 * migrates the v1 `keyOverrides` map into it, and `restorableShipped` names the
 * shipped commands a user deleted. A DIFF, not a copy: a corrected URL in a
 * later build still reaches a user who only renamed the command.
 */

import type { Category, Command, Overrides, ShortcutEdit } from './types';
import { CATEGORIES } from './types';
import { MAX_KEYWORD_LENGTH, validateAlias, validateUrlTemplate } from './validate';

/**
 * Marks an id as belonging to a user-created shortcut, and is what makes
 * minting collision-free: only minting can put a shortcut in this namespace.
 * `shortcutId` enforces that — an alias may legally contain a `:`
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
 * than `SAFE_KEYWORD` on purpose — dashes only, so a minted id is also a
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
 * value could not be an id at all — a non-string, one with whitespace in it,
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
 * alias so a command that predates ids — every builtin, and every custom
 * command in a v1 blob — still has an identity without a migration.
 */
export function shortcutId(cmd: Command): string {
  const id = normalizeId(cmd?.id);
  if (id) return id;
  // A keyword may contain a `:`, so a command keyed `u:tix` would otherwise
  // fall back into the namespace only minting is allowed to fill — and share an
  // id with whatever storage did mint for it. It has no identity until storage
  // gives it one, and saying so is better than inventing a colliding answer.
  const key = normalizeId(cmd?.keys?.[0]);
  return isUserId(key) ? '' : key;
}

export function isUserId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(USER_ID_PREFIX);
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
 * Every field an edit may name, in the order the form shows them. It is what
 * `editedFields` reports and the order it reports them in, so the "edited"
 * badge and the import merge plan read a diff the same way the form does.
 */
const EDITABLE_FIELDS = [
  'keys',
  'name',
  'description',
  'url',
  'searchUrl',
  'category',
  'example',
] as const;

/**
 * Folds a stored edit onto a shipped command, without mutating either.
 *
 * SECURITY: `handler`, `provider`, `builtin` and `id` are never read from
 * `edit` — the fields are copied one at a time instead of spreading, so an
 * import file that invents them changes nothing (invariant 16). Do not add
 * `next.handler = cmd.handler` "for clarity": it would put an
 * `undefined`-valued key on every merged command.
 *
 * Absent is "inherit" everywhere, so a half-written edit degrades to the
 * shipped definition rather than to a broken command.
 */
export function applyEdit(cmd: Command, edit: ShortcutEdit | undefined): Command {
  if (!edit) return cmd;
  const next: Command = { ...cmd };

  const keys = aliasList(edit.keys);
  // An empty list means "no override", not "no aliases" — otherwise a
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

  // An id nobody ships is dropped, not coerced to `custom`: a shipped command
  // must not be silently relocated to "My shortcuts" because the file named a
  // category this build does not have.
  const category = text(edit.category).toLowerCase();
  if (isCategory(category)) next.category = category;

  return next;
}

/**
 * The inverse: what would have to be stored for `applyEdit(shipped, …)` to
 * produce `next`. `null` when nothing differs, so "reset to shipped" is
 * representable as the absence of an entry rather than as an empty object.
 *
 * A change `applyEdit` could not carry back — a blanked name, a url that is not
 * a URL — is reported as no change, because storing it would produce a diff
 * that does not round trip.
 */
export function diffEdit(shipped: Command, next: Command): ShortcutEdit | null {
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
  // up unset are NOT the same answer here — a blank one is a removal, while one
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
  if (isCategory(category) && category !== text(shipped?.category).toLowerCase()) {
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
 * The fields this edit actually moves off the shipped definition, for the
 * "edited" badge and the import merge plan.
 *
 * Asked of the RESULT, not of the keys the edit happens to carry: an edit
 * naming a field and setting it to the value the command already ships with has
 * changed nothing, and a row that claims otherwise sends the user looking for a
 * difference that is not there.
 */
export function editedFields(shipped: Command, edit: ShortcutEdit | undefined): string[] {
  const diff = diffEdit(shipped, applyEdit(shipped, edit));
  if (!diff) return [];
  return EDITABLE_FIELDS.filter((field) => field in diff);
}

/**
 * The v1 reader for rebinding. Format 1 stored replacement aliases in their own
 * `Overrides.keyOverrides` map; format 2 has one writer for `keys`, the edit
 * layer, because two of them is exactly the drift that lets a rebind persist in
 * one place and be read from the other.
 *
 * Exported from here rather than hidden in storage so the lenient path and the
 * strict import parser fold identically — a v1 export file and a v1 stored blob
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
    // The legacy map predates user ids, so a `u:` key in one is a hand edit —
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

/** The shipped commands the user deleted, in registry order — what "Restore
 *  shipped shortcuts" offers. */
export function restorableShipped(builtins: Command[], overrides: Overrides): Command[] {
  const deleted = new Set(
    (overrides?.deleted ?? []).map((id) => normalizeId(id)).filter(Boolean),
  );
  return (builtins ?? []).filter((cmd) => deleted.has(shortcutId(cmd)));
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as string[]).includes(value);
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
