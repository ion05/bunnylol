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
  sectionKey,
  sectionLabel,
  sectionOrder,
  shortcutId,
} from '../../lib/overrides';
import type { Command, Overrides, Section } from '../../lib/types';

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

/** What the toolbar count line is told: the rows the filter left on screen, how
 *  many of those are switched on, and how many rows the list holds in all. */
export interface BrowseCounts {
  /** Rows the filter is showing, the ones under "Hidden shortcuts" included.
   *  Every row, when no query is live. */
  shown: number;
  /** Of those, the ones that are not switched off, so the ones still drawn in
   *  their own section. */
  on: number;
  /** Every row in the list, filtered out or switched off or not. */
  total: number;
}

/**
 * The id the "Hidden shortcuts" group folds under.
 *
 * A section id is minted from its label through `validateSectionId`, which
 * takes `^[a-z0-9][a-z0-9-]*$`, so nothing the user can type mints an id
 * starting with `@`. That is the whole point of the character: the fold lives
 * in the same `localStorage` set as the real sections, and a key a user could
 * mint would let a section called "Hidden" inherit this group's fold, or fold
 * this group by being renamed.
 */
export const HIDDEN_GROUP_ID = '@hidden';

/** A section heading and the shortcuts filed under it. */
export interface BrowseGroup {
  /** The section id, which is also what the fold is remembered under. */
  id: string;
  label: string;
  /** Every shortcut in the section, switched off or not. The view draws the
   *  live ones here and the switched-off ones under "Hidden shortcuts", but a
   *  row switched back on has to know which section it belongs in, so the
   *  grouping cannot drop them. */
  entries: Entry[];
}

/**
 * The section groups, in the order the page draws them.
 *
 * Sections with nothing in them at all are skipped; a section whose shortcuts
 * are ALL switched off is kept, because it is still a section, and the row that
 * the user switches back on has to have somewhere to land without a re-render.
 */
export function browseGroups(entries: Entry[], sections: Section[] | undefined): BrowseGroup[] {
  const groups: BrowseGroup[] = [];
  for (const id of sectionOrder(sections, entries.map((entry) => entry.cmd))) {
    // Through `sectionKey`, because that is what `sectionOrder` minted the id
    // with: comparing the raw strings drops a row whose stored category
    // differs only in case, and it would be dropped silently.
    const members = entries.filter((entry) => sectionKey(entry.cmd.category) === id);
    if (members.length === 0) continue;
    groups.push({ id, label: sectionLabel(id, sections), entries: members });
  }
  return groups;
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
