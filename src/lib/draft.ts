/**
 * The shape the add/edit form edits, and the pure parsing around it. No DOM:
 * the options page owns the widgets, this owns the string handling, so it can
 * be tested.
 */

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
  category: 'custom',
  example: '',
  newSectionLabel: '',
};

export type KeysCheck = { ok: true; keys: string[] } | { ok: false; reason: string };

/**
 * Splits a comma-separated keyword list through the shared alias validator, so
 * the new-shortcut form, the builtin key editor and the import path all reject
 * the same aliases. An alias the resolver cannot read as a keyword — one with a
 * space in it, say — works on no surface at all, so it has to fail here rather
 * than save and quietly fall through to a search.
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
