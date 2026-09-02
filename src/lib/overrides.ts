/**
 * Shortcut identity: the one answer to "which shortcut is this?".
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
 */

import type { Command } from './types';
import { MAX_KEYWORD_LENGTH } from './validate';

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
