/**
 * Shortcut suggestions: the sites a user keeps going back to, minus the ones a
 * shortcut already reaches, each with a keyword nothing else answers to.
 *
 * Pure, like `resolve.ts`: no `chrome.*` and no DOM. The pages come from
 * `chrome.history` through `lib/history.ts`, which is the only file that knows
 * where they came from, so this ranking is testable with a plain array.
 *
 * A suggestion only ever becomes a shortcut through the ordinary New shortcut
 * form (`prefillFor` → `#new?prefill=`), so nothing here writes, and every
 * keyword still meets `validateAlias` on the way in.
 */

import { SEARCH_ENGINES } from './commands';
import { buildKeyMap } from './resolve';
import type { Command } from './types';
import { validateAlias } from './validate';

export interface VisitedPage {
  url: string;
  title?: string;
  visitCount?: number;
  typedCount?: number;
}

export interface Suggestion {
  alias: string;
  /** The site's origin: a shortcut to the home page, never to one deep link. */
  url: string;
  name: string;
  /** Hostname without `www.`: what a dismissal records. */
  host: string;
  score: number;
}

/** Typing an address is the habit a keyword replaces, so it counts triple. */
const TYPED_WEIGHT = 3;
/** Below this a site was visited, not returned to. */
const MIN_SCORE = 5;

export function suggestShortcuts(
  pages: VisitedPage[],
  commands: Command[],
  dismissed: string[],
  limit = 5,
): Suggestion[] {
  const skip = new Set(dismissed.map((host) => host.toLowerCase()));
  for (const engine of SEARCH_ENGINES) skip.add(bareHost(engine.host));
  for (const cmd of commands) {
    for (const url of [cmd.url, cmd.searchUrl]) {
      const host = hostOf(url ?? '');
      if (host) skip.add(host);
    }
  }

  const sites = new Map<string, { score: number; origin: string; title: string; best: number }>();
  for (const page of pages) {
    let url: URL;
    try {
      url = new URL(page.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const host = bareHost(url.hostname);
    if (skip.has(host) || !isPublicHost(host)) continue;
    const score = (page.visitCount ?? 0) + TYPED_WEIGHT * (page.typedCount ?? 0);
    const site = sites.get(host) ?? { score: 0, origin: `${url.origin}/`, title: '', best: -1 };
    site.score += score;
    // The name comes off the most visited page of the site, which is usually
    // the one titled after the site rather than after one document on it.
    if (score > site.best) {
      site.best = score;
      site.title = page.title ?? '';
    }
    sites.set(host, site);
  }

  const taken = new Set(buildKeyMap(commands).keys());
  const out: Suggestion[] = [];
  const ranked = [...sites].filter(([, s]) => s.score >= MIN_SCORE);
  ranked.sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  for (const [host, site] of ranked) {
    if (out.length >= limit) break;
    const alias = pickAlias(host, taken);
    if (!alias) continue;
    taken.add(alias);
    out.push({ alias, url: site.origin, name: siteName(site.title, host), host, score: site.score });
  }
  return out;
}

/** The `#new?prefill=` text `parsePrefill` reads back: keyword, URL, name. */
export function prefillFor(s: Suggestion): string {
  return `${s.alias} ${s.url} ${s.name}`;
}

function hostOf(url: string): string {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return '';
  }
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function isPublicHost(host: string): boolean {
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost')) return false;
  // An IPv4 address or a bracketed IPv6 one names a machine, not a site.
  return !/^[\d.]+$/.test(host) && !host.startsWith('[');
}

/**
 * The label a person would call the site by: `linear.app` → `linear`,
 * `mail.proton.me` → `proton`, `bbc.co.uk` → `bbc`. Then the subdomain
 * (`docs.google.com` → `docs`), then a prefix, then a numbered one.
 */
function pickAlias(host: string, taken: Set<string>): string {
  const main = mainLabel(host);
  const labels = host.split('.');
  const candidates = [main, labels[0]!, main.slice(0, 2), main.slice(0, 3)];
  for (let n = 2; n < 10; n++) candidates.push(`${main}${n}`);
  for (const candidate of candidates) {
    const check = validateAlias(candidate.replace(/[^a-z0-9-]/g, ''));
    if (check.ok && check.alias.length > 1 && !taken.has(check.alias)) return check.alias;
  }
  return '';
}

function mainLabel(host: string): string {
  const labels = host.split('.');
  // ponytail: no public-suffix list. Two short trailing labels (co.uk, com.au)
  // are read as one suffix; a rarer shape just gets a less obvious keyword.
  const suffix =
    labels.length > 2 && labels.at(-1)!.length <= 3 && labels.at(-2)!.length <= 3 ? 2 : 1;
  return labels[labels.length - suffix - 1] ?? labels[0]!;
}

/** `Linear – Plan and build products` → `Linear`; no title → `Linear` off the host. */
function siteName(title: string, host: string): string {
  const lead = title.split(/\s+[|\-–—·:]\s+/)[0]?.trim() ?? '';
  if (lead && lead.length <= 40) return lead;
  const label = mainLabel(host);
  return label.charAt(0).toUpperCase() + label.slice(1);
}
