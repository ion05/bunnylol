/**
 * The add/edit form's validation and command-building, pure and DOM-free so it
 * is testable under node. `Draft`, `parseKeys`, `splitKeys` and `withScheme`
 * live in `../../lib/draft` (shared with the import parser and the builtin key
 * editor); this module is what turns a draft into a `Command` and into the
 * `Problem`s the form paints next to each field.
 */

import type { Draft } from '../../lib/draft';
import { parseKeys, splitKeys, withScheme } from '../../lib/draft';
import { shortcutId } from '../../lib/overrides';
import { normalizeCategory } from '../../lib/storage';
import { isInterceptableAlias } from '../../lib/validate';
import type { Command, Overrides } from '../../lib/types';

export type FormField = 'keys' | 'url' | 'searchUrl';

/** Form order, which is also the order `submit()` hunts for the field to focus. */
export const FORM_FIELDS: FormField[] = ['keys', 'url', 'searchUrl'];

export interface Problem {
  level: 'error' | 'warn';
  text: string;
  field?: FormField;
}

/**
 * Everything `validateDraft` needs from outside the draft itself: the alias
 * ownership map (who currently answers to which keyword), the user's own
 * shortcuts (to tell "yours" clashes from builtin ones), the shipped registry
 * (to name a builtin's spare aliases), and which shortcut, if any, is being
 * edited (so a shortcut does not clash with its own keywords).
 */
export interface FormContext {
  editingId: string;
  owners: Map<string, string>;
  custom: Command[];
  builtins: Command[];
}

export function validateDraft(draft: Draft, ctx: FormContext): Problem[] {
  const problems: Problem[] = [];
  const parsed = parseKeys(draft.keys);
  const keys = parsed.ok ? parsed.keys : [];

  if (!parsed.ok) {
    problems.push({ level: 'error', field: 'keys', text: parsed.reason });
  } else if (keys.length === 0) {
    problems.push({
      level: 'error',
      field: 'keys',
      text: 'Add at least one keyword — that is what you type in the address bar.',
    });
  }
  for (const key of keys) {
    if (!isInterceptableAlias(key)) {
      problems.push({
        level: 'warn',
        field: 'keys',
        text: `“${key}” is not intercepted in the address bar — typing it there runs a normal search. It still works from the toolbar popup and from bl + Tab.`,
      });
    }
  }

  const mine = new Map(ctx.custom.map((cmd) => [shortcutId(cmd), cmd] as const));
  for (const key of keys) {
    const ownerId = ctx.owners.get(key);
    if (!ownerId || ownerId === ctx.editingId) continue;
    const clash = mine.get(ownerId);
    if (clash) {
      problems.push({
        level: 'error',
        field: 'keys',
        text: `“${key}” is already used by your shortcut “${clash.name}”. Pick another keyword, or edit that one instead.`,
      });
    } else {
      const builtin = ctx.builtins.find((cmd) => shortcutId(cmd) === ownerId);
      const spare = (builtin?.keys ?? []).filter((alias) => alias.toLowerCase() !== key);
      problems.push({
        level: 'warn',
        field: 'keys',
        text: spare.length
          ? `“${key}” currently opens ${builtin?.name ?? ownerId}. Your shortcut will take over; that one stays reachable as ${spare.join(', ')}.`
          : `“${key}” currently opens ${builtin?.name ?? ownerId}. Your shortcut will take over and that one loses its only keyword.`,
      });
    }
  }

  if (!draft.url.trim()) {
    problems.push({
      level: 'error',
      field: 'url',
      text: 'Destination URL is required — a bare keyword has to go somewhere.',
    });
  } else {
    const problem = urlProblem(withScheme(draft.url), 'Destination URL', 'url');
    if (problem) problems.push(problem);
  }

  const searchUrl = draft.searchUrl.trim();
  if (searchUrl) {
    const problem = urlProblem(withScheme(searchUrl), 'Search URL', 'searchUrl');
    if (problem) problems.push(problem);
    else if (!searchUrl.includes('{q}') && !searchUrl.includes('%s')) {
      problems.push({
        level: 'warn',
        field: 'searchUrl',
        text: 'Search URL has no {q}, so BunnyLol will append the arguments as ?q=… Add {q} to place them yourself.',
      });
    }
  }

  return problems;
}

export function urlProblem(value: string, label: string, field: FormField): Problem | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { level: 'error', field, text: `${label} is not a valid URL.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { level: 'error', field, text: `${label} must start with http:// or https://.` };
  }
  return null;
}

/**
 * Stricter than `urlProblem`, because this one field swallows every unmatched
 * search on all three surfaces: `gogle/search?q={q}` parses as a URL with the
 * host `gogle`, and no scheme is added for the user here — silently rewriting
 * what they typed is how a typo becomes the live default engine.
 */
export function engineProblem(value: string): Problem | null {
  const label = 'Fallback URL template';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return {
      level: 'error',
      field: 'url',
      text: `${label} has no scheme. Start it with https:// so it is clear where the search goes.`,
    };
  }
  const problem = urlProblem(value, label, 'url');
  if (problem) return problem;

  const host = new URL(value).hostname;
  if (/[{}]/.test(host)) {
    return {
      level: 'error',
      field: 'url',
      text: `“${host}” is not a host name. A placeholder belongs in the path or the query string, not in the domain.`,
    };
  }
  // `localhost` is the one single-label host a self-hosted engine really uses;
  // anything else without a dot is a typo, and a typo here breaks every search.
  if (!host.includes('.') && host !== 'localhost') {
    return {
      level: 'error',
      field: 'url',
      text: `“${host}” is not a full domain name. Use something like https://example.com/search?q={q}.`,
    };
  }
  return null;
}

/** Splices the draft into the override layer it targets, so the live preview
 *  shows the shipped shortcut's edited destination while it is being typed. */
export function previewOverrides(draft: Command, editing: string, overrides: Overrides): Overrides {
  const custom = editing
    ? overrides.custom.map((cmd) => (shortcutId(cmd) === editing ? draft : cmd))
    : [...overrides.custom, draft];
  return { ...overrides, custom };
}

export function buildCommand(draft: Draft, knownIds: Set<string>): Command {
  const parsed = parseKeys(draft.keys);
  // The live preview builds a command while the form is still being typed into,
  // so a rejected alias falls back to the raw split rather than blanking the row.
  const keys = parsed.ok ? parsed.keys : splitKeys(draft.keys);
  const cmd: Command = {
    keys,
    name: draft.name.trim() || keys[0] || 'Untitled',
    description: draft.description.trim(),
    url: withScheme(draft.url),
    // `Draft.category` is an open id; the registry's is not. Narrow it through
    // the same check storage applies to a stored blob rather than casting.
    category: normalizeCategory(draft.category, knownIds),
    builtin: false,
  };
  const searchUrl = draft.searchUrl.trim();
  if (searchUrl) cmd.searchUrl = withScheme(searchUrl);
  // No `example`: it is derived from the keys at render time by `exampleOf`,
  // so a throwaway value typed into the preview never becomes label text.
  return cmd;
}
