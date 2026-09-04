/**
 * Persistence: one JSON blob under one key in `chrome.storage.local`.
 *
 * Deliberately not `storage.sync`: it syncs only between profiles signed into
 * the same Chrome account, so it would not carry a shortcut to the other
 * browsers this runs in anyway, and the whole state is one item against an 8 KB
 * per-item cap. Each profile keeps its own state and shortcuts travel between
 * them through the export/import file instead.
 *
 * Everything coming out of storage or off disk is treated as hostile: a
 * half-finished write, a hand-edited export or a blob from a future build must
 * degrade to defaults rather than throw on a navigation path. `importJson` is
 * the one exception: it throws, because a human is standing in the options
 * page waiting to read the message.
 *
 * That one exception is why the two readers are two files:
 *
 *   `storage/normalize.ts`    LENIENT. Recovers what it can from any blob and
 *                             never throws. Runs on the navigation path.
 *   `storage/parse-import.ts` STRICT. Refuses a file it cannot read, with a
 *                             message naming the field. Runs behind Import.
 *   `storage/shared.ts`       What both need: the type guards, the shipped-id
 *                             set, and the custom-id pass they share.
 *
 * This file keeps the chrome I/O, the change subscription and the export, and
 * stays the public entry point: `importJson`, `ImportedState` and
 * `normalizeCategory` are re-exported below, so every surface imports
 * `lib/storage` and nothing reaches past it.
 */

import type { Command, Overrides, Settings, StoredState } from './types';
import { STORAGE_KEY } from './types';
import { BUILTIN_COMMANDS } from './commands';
import { mergeCommands } from './resolve';
import { EXPORT_VERSION } from './storage/shared';
import { normalizeSettings, normalizeState } from './storage/normalize';
import type { ImportedState } from './storage/parse-import';

// ----------------------------------------------------------------- reading ----

/** Narrow feature test so this module imports cleanly under vitest in Node. */
function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && chrome.storage?.local != null;
}

/** Throws when storage itself fails; returns defaults when there is no chrome. */
async function readState(): Promise<StoredState> {
  if (!hasChromeStorage()) return normalizeState(null);
  const bag = await chrome.storage.local.get<Record<string, unknown>>(STORAGE_KEY);
  return normalizeState(bag?.[STORAGE_KEY]);
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

/** The single call every consumer makes before resolving a query. */
export async function loadResolveContext(): Promise<{ commands: Command[]; settings: Settings }> {
  const { overrides, settings } = await loadState();
  return { commands: mergeCommands(BUILTIN_COMMANDS, overrides), settings };
}

// ----------------------------------------------------------------- writing ----

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

// ------------------------------------------------- the change subscription ----

export function onStateChanged(cb: (s: StoredState) => void): void {
  if (!hasChromeStorage() || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[STORAGE_KEY];
    // `newValue` is undefined when the key was cleared, which normalizes to
    // defaults: exactly what a listener should render at that point.
    if (change) cb(normalizeState(change.newValue));
  });
}

// ------------------------------------------------------- export and import ----

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

// --------------------------------------------------------- the two readers ----

// Re-exported rather than moved: `lib/storage` is the path every surface
// already imports, and the split is an arrangement of this module's insides,
// not a new boundary for its callers to learn. `normalizeCategory` is public
// because the options form narrows a `Draft.category` exactly the way a stored
// blob is narrowed (`model/form.ts`); `importJson` and `ImportedState` because
// the Data view reads a file and hands the result to `applyImport`.
export { normalizeCategory } from './storage/normalize';
export { importJson } from './storage/parse-import';
export type { ImportedState } from './storage/parse-import';
