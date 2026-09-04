/**
 * The pieces both storage readers share, and the one file in this folder that
 * imports neither of them.
 *
 * `storage/normalize.ts` recovers something usable from any blob; the strict
 * import parser in `storage/parse-import.ts` refuses a file it cannot read.
 * Both still need the same type guards, the same list of ids this build ships
 * and the same answer to "which `u:` id does this custom shortcut get", so
 * those live here rather than in one family with the other reaching across for
 * them, which would be a cycle the moment either grew a call back.
 *
 * Nothing here throws EXCEPT `claimedId` under `strict`, which is the seam
 * between the two behaviours: one function, one pass over the list, and a flag
 * that says whether an id it cannot honour is re-minted or reported.
 */

import type { Command } from '../types';
import { BUILTIN_COMMANDS } from '../commands';
import {
  MAX_ID_LENGTH,
  USER_ID_PREFIX,
  firstKey,
  isUserId,
  mintUserId,
  normalizeId,
  shortcutId,
} from '../overrides';
import { validateUrlTemplate } from '../validate';

// --------------------------------------------------------- the file format ----

/**
 * Bumped only when the export file's shape changes incompatibly. Format 2
 * replaced `keyOverrides` with the `edits` layer; format 1 files still load,
 * through `foldLegacyKeyOverrides`.
 */
export const EXPORT_VERSION = 2;

/**
 * Ids this build actually ships, used to prune `deleted`: an entry naming a
 * command that no longer exists is a shortcut nobody can restore, and keeping
 * it would let one removed in v1.0 come back as a tombstone forever. `edits`
 * for a vanished id are left alone: they are inert and cost nothing.
 */
export const SHIPPED_IDS = new Set(BUILTIN_COMMANDS.map(shortcutId));

// ------------------------------------------------------------- type guards ----

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The lenient half of the URL boundary: an unusable destination becomes an
 * empty string, which each caller turns into a default or a dropped entry. A
 * stored blob that predates this check must not be able to brick the profile,
 * so nothing here throws.
 */
export function safeUrl(value: unknown): string {
  const check = validateUrlTemplate(trimmed(value));
  return check.ok ? check.url : '';
}

// ----------------------------------------------------- custom shortcut ids ----

/** A normalized custom command next to the entry it came from, which still
 *  carries the `id` the file claimed. */
export interface CustomEntry {
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
 * claim's owner onto a different one: the same silent adoption of another
 * shortcut's override entries as a claimed shipped id, arriving from a sibling
 * instead of from the registry, and turning on nothing but the order of the
 * file. Between two entries claiming the same id the first still wins; the
 * second is minted over, because one id naming two shortcuts is the thing all
 * of this exists to prevent.
 */
export function assignCustomIds(entries: CustomEntry[], strict: boolean): Command[] {
  // Paired with the entry rather than kept as a second array read back by
  // index, so a claim cannot come apart from the entry that made it.
  const claimed = entries.map((entry) => ({ entry, claim: claimedId(entry, strict) }));
  // Seeded with the claims, so a mint cannot land on one that is still owed.
  const taken = new Set(claimed.map(({ claim }) => claim).filter(isUserId));
  const handedOut = new Set<string>();
  return claimed.map(({ entry, claim }) => {
    // `firstKey`, the seed `merge-import` mints from too: a normalized command
    // always has an alias, and this says so without indexing past a length.
    const id =
      isUserId(claim) && !handedOut.has(claim) ? claim : mintUserId(firstKey(entry.cmd), taken);
    taken.add(id);
    handedOut.add(id);
    return { ...entry.cmd, id };
  });
}

/**
 * The id an entry asks for, or `''` when it asks for nothing usable.
 *
 * A claim is honoured only when it is a USER id. An id without the `u:` prefix
 * names a shipped shortcut, this build's or a later one's, and a command
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
        : `Shortcut "${cmd.keys[0]}" claims the id "${written}", which is reserved for shipped shortcuts. Your own shortcuts have ids starting with "${USER_ID_PREFIX}". Remove its "id" field.`,
    );
  }
  return '';
}
