/**
 * What the browse list shows. No DOM, no `chrome.*`: every function here
 * takes the state it needs as a parameter, so the browse view's grouping and
 * filtering logic is testable under node.
 */

import {
  applyEdit,
  diffEdit,
  firstKey,
  knownCategoryIds,
  normalizeId,
  shortcutId,
} from '../../lib/overrides';
import type { Command, Overrides } from '../../lib/types';

/** A browse row. Disabled builtins are missing from the merged list, so the
 *  browse view is built from the raw registry plus the override layer. */
export interface Entry {
  /** Stable identity for the override layer: `shortcutId`. */
  id: string;
  /** Key the merged command answers to, used to line rows up with `suggest()`. */
  matchKey: string;
  cmd: Command;
  /** Whether the shortcut comes from the registry. Every row offers the same
   *  three actions either way; this only decides where Delete and Save write. */
  shipped: boolean;
  disabled: boolean;
  /** Whether the shortcut now reads differently from how it shipped: what the
   *  "modified" badge reports, and the only thing on the row that says so. A
   *  stored edit that changes nothing is not a difference. */
  modified: boolean;
}

/**
 * What the browse list shows, in the same order and with the same overrides
 * applied as `mergeCommands`: a row that claims a keyword the resolver does
 * not answer to is worse than no row.
 */
export function browseEntries(builtins: Command[], overrides: Overrides): Entry[] {
  // Through `normalizeId`, the same reader `mergeCommands` uses: a row that
  // disagrees with the resolver about which ids are off is the bug this page
  // exists to prevent.
  const disabled = new Set(overrides.disabled.map(normalizeId).filter(Boolean));
  const deleted = new Set(overrides.deleted.map(normalizeId).filter(Boolean));
  const entries: Entry[] = overrides.custom.map((cmd) => {
    const id = shortcutId(cmd);
    return {
      id,
      matchKey: firstKey(cmd),
      cmd,
      shipped: false,
      disabled: disabled.has(id),
      // A custom command is edited in place, so there is nothing it could
      // differ from and `edits` never holds an entry for one.
      modified: false,
    };
  });

  const known = knownCategoryIds(overrides.sections);
  for (const cmd of builtins) {
    const id = shortcutId(cmd);
    // A deleted shipped shortcut is not merged, so listing it here would offer
    // an Edit for something no surface resolves. It comes back through
    // Settings, not through this list.
    if (deleted.has(id)) continue;
    const shipped = { ...cmd, id, keys: [...cmd.keys] };
    const edited = applyEdit(shipped, overrides.edits[id], known);
    entries.push({
      id,
      matchKey: (edited.keys[0] ?? id).trim().toLowerCase(),
      cmd: edited,
      shipped: true,
      disabled: disabled.has(id),
      // Whether the edit makes a DIFFERENCE, not whether one is stored: an
      // edit that says nothing (a no-op an import can carry, and which
      // survives storage) would otherwise show a badge Reset cannot clear,
      // because Save writes the diff and the diff is empty.
      modified: diffEdit(shipped, edited, known) !== null,
    });
  }
  return entries;
}

/** What the two count labels are told: the rows the filter left on screen, how
 *  many of those are switched on, and how many rows the list holds in all. */
export interface BrowseCounts {
  /** Rows the filter is showing. Every row, when no query is live. */
  shown: number;
  /** Of those, the ones that are not switched off. */
  on: number;
  /** Every row in the list, filtered out or not. */
  total: number;
}

/**
 * The number beside a group heading.
 *
 * A pack the user declined leaves its group listed at full strength with every
 * row dimmed, and a bare "12" beside twelve switched-off shortcuts reads as
 * twelve live ones: the picker looked like it did nothing. The bare number
 * stays for a group with nothing off, because "12 of 12 on" on every heading is
 * noise in the ordinary case.
 */
export function groupCountLabel(on: number, shown: number): string {
  return on === shown ? String(shown) : `${on} of ${shown} on`;
}

/**
 * The toolbar's count line. It answers two different questions and asks each
 * one only when it has something to say.
 *
 * "N of M" means matched out of all while a query is live, and on out of all
 * when there is none, so the two cannot share a phrase: with a query up, the
 * count of what is on is a separate clause rather than a second reading of the
 * same pair of numbers.
 */
export function countLabel(counts: BrowseCounts, filtered: boolean): string {
  const { on, shown, total } = counts;
  if (!filtered) return on === total ? `${total} shortcuts` : `${on} of ${total} shortcuts on`;
  const matched = `${shown} of ${total} shortcuts`;
  return on === shown ? matched : `${matched}, ${on} on`;
}

export function haystackOf(cmd: Command): string {
  const destinations = `${cmd.url} ${cmd.searchUrl ?? ''}`;
  return `${cmd.keys.join(' ')} ${cmd.name} ${cmd.description} ${destinations}`.toLowerCase();
}

/** Persisted examples win; the rest are derived so a sample argument typed into
 *  the preview never becomes permanent label text. */
export function exampleOf(cmd: Command): string {
  if (cmd.example) return cmd.example;
  const key = cmd.keys[0];
  if (cmd.builtin || !key || !cmd.searchUrl) return '';
  return `${key} <arguments>`;
}

/** alias -> owning command id, across everything currently active. */
export function buildKeyOwner(entries: Entry[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const entry of entries) {
    if (entry.disabled) continue;
    for (const key of entry.cmd.keys) {
      const alias = key.trim().toLowerCase();
      if (alias && !owner.has(alias)) owner.set(alias, entry.id);
    }
  }
  return owner;
}
