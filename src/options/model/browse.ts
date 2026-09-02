/**
 * What the browse list shows. No DOM, no `chrome.*` — every function here
 * takes the state it needs as a parameter, so the browse view's grouping and
 * filtering logic is testable under node.
 */

import { applyEdit, firstKey, knownCategoryIds, normalizeId, shortcutId } from '../../lib/overrides';
import type { Command, Overrides } from '../../lib/types';

/** A browse row. Disabled builtins are missing from the merged list, so the
 *  browse view is built from the raw registry plus the override layer. */
export interface Entry {
  /** Stable identity for the override layer: `shortcutId`. */
  id: string;
  /** Key the merged command answers to, used to line rows up with `suggest()`. */
  matchKey: string;
  cmd: Command;
  disabled: boolean;
}

/**
 * What the browse list shows, in the same order and with the same overrides
 * applied as `mergeCommands` — a row that claims a keyword the resolver does
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
    return { id, matchKey: firstKey(cmd), cmd, disabled: disabled.has(id) };
  });

  for (const cmd of builtins) {
    const id = shortcutId(cmd);
    // A deleted shipped shortcut is not merged, so listing it here would offer
    // a rebind for something no surface resolves. It comes back through
    // Settings, not through this list.
    if (deleted.has(id)) continue;
    const edited = applyEdit(
      { ...cmd, id, keys: [...cmd.keys] },
      overrides.edits[id],
      knownCategoryIds(overrides.sections),
    );
    entries.push({
      id,
      matchKey: (edited.keys[0] ?? id).trim().toLowerCase(),
      cmd: edited,
      disabled: disabled.has(id),
    });
  }
  return entries;
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

export function describeOwner(entries: Entry[], id: string): string {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return `“${id}”`;
  return `${entry.cmd.name} (${entry.cmd.builtin ? 'built in' : 'your shortcut'})`;
}
