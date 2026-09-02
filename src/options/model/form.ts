/**
 * The add/edit form's validation, pure and DOM-free so it is testable under
 * node. `Draft`, `parseKeys`, `withScheme` and `buildCommand` live in
 * `../../lib/draft` (shared with the import parser); this module is what turns
 * a draft into the `Problem`s the form paints next to each field, and what
 * narrows the draft's open category before handing it to that builder.
 */

import type { Draft } from '../../lib/draft';
import { buildCommand as buildDraftCommand, parseKeys, withScheme } from '../../lib/draft';
import { normalizeId, sectionLabelTaken, shortcutId } from '../../lib/overrides';
import { mergeCommands } from '../../lib/resolve';
import { normalizeCategory } from '../../lib/storage';
import { isInterceptableAlias, validateSectionLabel } from '../../lib/validate';
import type { Command, Overrides, Section, ShortcutEdit } from '../../lib/types';

export type FormField = 'keys' | 'url' | 'searchUrl' | 'category';

/** Form order, which is also the order `submit()` hunts for the field to focus. */
export const FORM_FIELDS: FormField[] = ['keys', 'url', 'searchUrl', 'category'];

/**
 * The category select's last option. A sentinel rather than an empty value
 * because a blank `<select>` value is indistinguishable from a select the
 * browser could not set, and this one has to survive a round trip through
 * `readDraft`.
 */
export const NEW_SECTION_VALUE = '__new_section__';

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
  /** The sections this profile has, for the "New section…" row's label check. */
  sections: Section[];
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
      text: 'Add at least one keyword. That is what you type in the address bar.',
    });
  }
  for (const key of keys) {
    if (!isInterceptableAlias(key)) {
      problems.push({
        level: 'warn',
        field: 'keys',
        text: `“${key}” is not intercepted in the address bar. Typing it there runs a normal search. It still works from the toolbar popup and from bl + Tab.`,
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
      problems.push({ level: 'warn', field: 'keys', text: clashText(key, ownerId, ctx) });
    }
  }

  if (!draft.url.trim()) {
    problems.push({
      level: 'error',
      field: 'url',
      text: 'Destination URL is required. A bare keyword has to go somewhere.',
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

  if (draft.category === NEW_SECTION_VALUE) {
    // The label lives in its own field but reports against `category`: that is
    // the control the user chose "New section…" in, and the row it reveals is
    // part of that field rather than a field of its own.
    const check = validateSectionLabel(draft.newSectionLabel);
    if (!check.ok) {
      problems.push({
        level: 'error',
        field: 'category',
        text: `The new section's name ${check.reason}.`,
      });
    } else if (sectionLabelTaken(check.label, ctx.sections)) {
      problems.push({
        level: 'error',
        field: 'category',
        text: `A section is already called “${check.label}”. Pick that one above, or use another name.`,
      });
    }
  }

  return problems;
}

/**
 * What a keyword an existing shortcut already owns means for this one.
 *
 * "Your shortcut will take over" is only true when the shortcut being edited
 * wins the alias, and between two SHIPPED shortcuts that is decided by registry
 * order, not by which one was edited last: `mergeCommands` preserves it and
 * `buildKeyMap` is first-writer-wins (invariant 10). Rebinding `set` onto `c`
 * used to promise it would take over, then quietly resolve to Claude.
 */
function clashText(key: string, ownerId: string, ctx: FormContext): string {
  const ownerIndex = ctx.builtins.findIndex((cmd) => shortcutId(cmd) === ownerId);
  const owner = ownerIndex >= 0 ? ctx.builtins[ownerIndex] : undefined;
  const name = owner?.name ?? ownerId;
  const spare = (owner?.keys ?? []).filter((alias) => alias.toLowerCase() !== key);
  const editedIndex = ctx.builtins.findIndex((cmd) => shortcutId(cmd) === ctx.editingId);
  const bothShipped = ownerIndex >= 0 && editedIndex >= 0;

  if (bothShipped && editedIndex > ownerIndex) {
    return `“${key}” currently opens ${name}. ${name} comes first in the shipped list and keeps “${key}”; this shortcut will not answer to it in the address bar.`;
  }
  const taker = bothShipped ? 'This shortcut' : 'Your shortcut';
  return spare.length
    ? `“${key}” currently opens ${name}. ${taker} will take over; that one stays reachable as ${spare.join(', ')}.`
    : `“${key}” currently opens ${name}. ${taker} will take over and that one loses its only keyword.`;
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
 * host `gogle`, and no scheme is added for the user here: silently rewriting
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

/**
 * The override layer the live preview runs against.
 *
 * The shortcut being edited is lifted out of `disabled` and `deleted`: the
 * preview answers "where does this definition go?", and a switched-off
 * shortcut would otherwise preview as a plain web search with the form giving
 * no hint why. `paintPreview` says so in words instead.
 *
 * For a user shortcut the draft replaces its own entry in `custom`, in place,
 * so it keeps the position `buildKeyMap` resolves it at.
 */
export function previewOverrides(
  overrides: Overrides,
  editing: string,
  draft: Command | null = null,
): Overrides {
  const next: Overrides = {
    ...overrides,
    disabled: overrides.disabled.filter((id) => normalizeId(id) !== editing),
    deleted: overrides.deleted.filter((id) => normalizeId(id) !== editing),
  };
  if (!draft) return next;
  let replaced = false;
  next.custom = overrides.custom.map((cmd) => {
    if (!editing || shortcutId(cmd) !== editing) return cmd;
    replaced = true;
    return draft;
  });
  if (!replaced) next.custom = [...next.custom, draft];
  return next;
}

/**
 * The command list the live preview resolves against: the real merge, so the
 * preview is the real resolver and not a second opinion.
 *
 * A shipped target is substituted AT ITS OWN INDEX in the registry rather than
 * appended to `custom`. `buildKeyMap` is first-writer-wins and `mergeCommands`
 * puts custom commands first (invariant 10), so splicing the draft into
 * `custom` would hand it every alias it claims, including one an earlier
 * builtin owns, which the save then does not give it. Editing `set` to claim
 * `c` previewed as Settings and resolved to Claude.
 *
 * Its `edits` entry goes with it: the draft already has the edit applied
 * (the form prefills from the merged command), and `applyEdit` on top would
 * put the saved URL back over the one being typed.
 */
export function previewCommands(
  builtins: Command[],
  overrides: Overrides,
  draft: Command,
  editing: string,
  shipped = false,
): Command[] {
  const index =
    shipped && editing ? builtins.findIndex((cmd) => shortcutId(cmd) === editing) : -1;
  if (index < 0) return mergeCommands(builtins, previewOverrides(overrides, editing, draft));

  const registry = [...builtins];
  registry[index] = draft;
  const base = previewOverrides(overrides, editing);
  const edits: Record<string, ShortcutEdit> = { ...base.edits };
  delete edits[editing];
  return mergeCommands(registry, { ...base, edits });
}

/**
 * The form's `buildCommand`: `../../lib/draft`'s, with the category narrowed
 * first. There is one builder, not two: a second one is how the preview and
 * the save start disagreeing about what the form says.
 */
export function buildCommand(
  draft: Draft,
  knownIds: Set<string>,
  base: Command | null = null,
  id = '',
): Command {
  // `Draft.category` is an open id; the registry's is not. Narrow it through
  // the same check storage applies to a stored blob rather than casting.
  const category = normalizeCategory(draft.category, knownIds);
  return buildDraftCommand({ ...draft, category }, base, id);
}
