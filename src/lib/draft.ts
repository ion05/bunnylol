/**
 * The shape the add/edit form edits, and the pure parsing around it. No DOM:
 * the options page owns the widgets, this owns the string handling, so it can
 * be tested.
 */

import { shortcutId } from './overrides';
import type { Command } from './types';
import { FALLBACK_SECTION } from './types';
import { validateAlias } from './validate';

export interface Draft {
  keys: string;
  name: string;
  description: string;
  url: string;
  searchUrl: string;
  /** Open section id; the caller validates it against the sections it knows. */
  category: string;
  example: string;
  /** Holds the label typed into the form's "New section…" row, not the command. */
  newSectionLabel: string;
}

export const EMPTY_DRAFT: Draft = {
  keys: '',
  name: '',
  description: '',
  url: '',
  searchUrl: '',
  category: FALLBACK_SECTION,
  example: '',
  newSectionLabel: '',
};

/**
 * The fields that describe the shortcut, as opposed to the form's own scratch
 * space. `newSectionLabel` is deliberately absent: it says what the "New
 * section…" row is holding, not what the shortcut is, and comparing it would
 * make a draft differ from its own baseline over text no shortcut ever stores.
 */
export const DRAFT_FIELDS = [
  'keys',
  'name',
  'description',
  'url',
  'searchUrl',
  'category',
  'example',
] as const;

/** A blank draft filed under `category`. Separate from `EMPTY_DRAFT` because
 *  that constant is shared and must not be handed out for a caller to mutate. */
export function emptyDraft(category: string = FALLBACK_SECTION): Draft {
  return { ...EMPTY_DRAFT, category };
}

/** The form's view of a command — the merged one, so editing a shipped
 *  shortcut starts from what it currently does rather than from what it ships
 *  with. */
export function draftFrom(cmd: Command): Draft {
  return {
    keys: cmd.keys.join(', '),
    name: cmd.name,
    description: cmd.description,
    url: cmd.url,
    searchUrl: cmd.searchUrl ?? '',
    category: cmd.category || FALLBACK_SECTION,
    example: cmd.example ?? '',
    newSectionLabel: '',
  };
}

/**
 * What Reset puts back for a shipped shortcut: the registry's own definition,
 * read past the edit layer entirely. `null` when the id names no shipped
 * command, which is how the form knows it is editing one of the user's own.
 */
export function shippedDraftFor(id: string, builtins: Command[]): Draft | null {
  const wanted = id.trim();
  if (!wanted) return null;
  const shipped = builtins.find((cmd) => shortcutId(cmd) === wanted);
  return shipped ? draftFrom(shipped) : null;
}

/** Whether two drafts describe the same shortcut, which is what decides
 *  whether Reset has anything left to put back. */
export function sameDraft(a: Draft, b: Draft): boolean {
  return DRAFT_FIELDS.every((name) => a[name] === b[name]);
}

export type KeysCheck = { ok: true; keys: string[] } | { ok: false; reason: string };

/**
 * Splits a comma-separated keyword list through the shared alias validator, so
 * the edit form and the import path reject the same aliases. An alias the
 * resolver cannot read as a keyword — one with a space in it, say — works on no
 * surface at all, so it has to fail here rather than save and quietly fall
 * through to a search.
 */
export function parseKeys(value: string): KeysCheck {
  const keys: string[] = [];
  for (const part of value.split(',')) {
    if (!part.trim()) continue;
    const result = validateAlias(part);
    if (!result.ok) {
      return { ok: false, reason: `That keyword ${result.reason}. Separate keywords with commas.` };
    }
    if (!keys.includes(result.alias)) keys.push(result.alias);
  }
  return { ok: true, keys };
}

/** The lenient split, for the live preview and the `add …` prefill: it keeps
 *  whatever was typed so a half-finished keyword still renders. */
export function splitKeys(value: string): string[] {
  const keys: string[] = [];
  for (const part of value.split(',')) {
    const key = part.trim().toLowerCase();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function looksLikeUrl(token: string): boolean {
  if (/^https?:\/\//i.test(token)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(token);
}

export function withScheme(value: string): string {
  const url = value.trim();
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

export function originOf(value: string): string {
  try {
    return `${new URL(value).origin}/`;
  } catch {
    return value;
  }
}

/**
 * `add tix https://example.com/search?q={q}` arrives here as the prefill: the
 * first token is the keyword, a token with `{q}` is the search URL, and a bare
 * URL is the destination. Anything left over becomes the name.
 */
export function parsePrefill(raw: string): Draft {
  const draft: Draft = { ...EMPTY_DRAFT };
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return draft;

  if (!looksLikeUrl(tokens[0])) draft.keys = splitKeys(tokens.shift() ?? '').join(', ');

  const urls: string[] = [];
  const words: string[] = [];
  for (const token of tokens) {
    if (looksLikeUrl(token)) urls.push(token);
    else words.push(token);
  }

  const templated = urls.find((url) => url.includes('{q}') || url.includes('%s'));
  const plain = urls.find((url) => url !== templated);
  if (templated) {
    draft.searchUrl = withScheme(templated);
    draft.url = plain ? withScheme(plain) : originOf(withScheme(templated));
  } else if (plain) {
    draft.url = withScheme(plain);
  }
  draft.name = words.join(' ');
  return draft;
}

/**
 * A URL field on its way back out of the form. `withScheme` is only applied to
 * a value the user actually changed: the meta shortcuts ship a *relative*
 * `options.html#…` destination (the dispatch page absolutises it — see
 * `commands.ts`), and scheming that unconditionally turned a no-change Save on
 * `bl`, `add` or `set` into a stored `https://options.html#help` that no longer
 * opens anything, permanently — Reset then Save re-mangled it.
 */
function keptUrl(typed: string, shipped: string | undefined): string {
  const value = typed.trim();
  if (shipped !== undefined && value === shipped.trim()) return shipped;
  return withScheme(value);
}

/**
 * A draft plus the shortcut it is an edit OF, turned back into a `Command`.
 *
 * `builtin`, `handler` and `provider` come from `base` and never from the
 * draft: they are the behaviour selector, and the difference between renaming
 * GitHub and pointing the `github` handler at your own host (AGENTS.md
 * invariant 16). The form shows none of them, so the only way one could reach
 * a draft is a bug, and carrying them across explicitly is what makes that
 * bug impossible rather than merely unlikely.
 *
 * `id` is passed rather than derived: a shortcut whose keys changed is still
 * the same shortcut, and `shortcutId` of the rebuilt command would say
 * otherwise.
 */
export function buildCommand(draft: Draft, base: Command | null, id: string): Command {
  const parsed = parseKeys(draft.keys);
  // The live preview builds a command while the form is still being typed into,
  // so a rejected alias falls back to the raw split rather than blanking the row.
  const keys = parsed.ok ? parsed.keys : splitKeys(draft.keys);
  const cmd: Command = {
    keys,
    name: draft.name.trim() || keys[0] || 'Untitled',
    description: draft.description.trim(),
    url: keptUrl(draft.url, base?.url),
    category: draft.category,
    builtin: base?.builtin === true,
  };
  const resolvedId = id.trim() || base?.id || '';
  if (resolvedId) cmd.id = resolvedId;
  const searchUrl = draft.searchUrl.trim();
  if (searchUrl) cmd.searchUrl = keptUrl(searchUrl, base?.searchUrl);
  const example = draft.example.trim();
  if (example) cmd.example = example;
  if (base?.handler) cmd.handler = base.handler;
  if (base?.provider) cmd.provider = base.provider;
  return cmd;
}
