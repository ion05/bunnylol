/**
 * The `chrome.history` side of shortcut suggestions: the one file that asks for
 * the permission and reads the visits. `history` is an OPTIONAL permission, so
 * nothing here assumes it is granted, and a profile that never opted in reads
 * as no suggestions rather than an error.
 *
 * The visits are read on demand and never stored. What persists is only
 * `settings.dismissedSuggestions`, the hosts a user said no to.
 */

import { suggestShortcuts } from './suggest';
import type { Suggestion } from './suggest';
import type { Command, Settings } from './types';

const HISTORY = { permissions: ['history'] };
/** How far back "a site you keep going back to" looks. */
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export async function hasHistoryAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(HISTORY);
  } catch {
    return false;
  }
}

/** Must run inside the click handler that asked: Chrome refuses it otherwise. */
export async function requestHistoryAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request(HISTORY);
  } catch {
    return false;
  }
}

export async function loadSuggestions(
  commands: Command[],
  settings: Settings,
  limit?: number,
): Promise<Suggestion[]> {
  if (!(await hasHistoryAccess())) return [];
  try {
    const pages = await chrome.history.search({
      text: '',
      startTime: Date.now() - WINDOW_MS,
      maxResults: 5000,
    });
    return suggestShortcuts(
      pages.map((page) => ({
        url: page.url ?? '',
        title: page.title,
        visitCount: page.visitCount,
        typedCount: page.typedCount,
      })),
      commands,
      settings.dismissedSuggestions,
      limit,
    );
  } catch {
    return [];
  }
}
