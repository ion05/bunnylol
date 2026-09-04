/**
 * Invariants of the shipped registry itself.
 *
 * `buildKeyMap` resolves an alias collision silently, first writer wins, so a
 * duplicate alias inside `BUILTIN_COMMANDS` does not fail anywhere, it just
 * makes one command permanently unreachable. Same for a `handler` string that
 * no longer names a function: `resolve` degrades to `cmd.url` and the smart
 * behaviour disappears without a word. These tests are the only thing standing
 * between a one-character typo and a dead shortcut.
 */

import { describe, expect, it } from 'vitest';
import { at } from './helpers/at';
import { BUILTIN_COMMANDS, SEARCH_ENGINES, destinationOf } from '../src/lib/commands';
import { AI_PROVIDERS, HANDLERS } from '../src/lib/handlers';
import { buildKeyMap, resolve } from '../src/lib/resolve';
import { CATEGORIES, DEFAULT_SETTINGS } from '../src/lib/types';
import type { Command } from '../src/lib/types';

describe('BUILTIN_COMMANDS registry', () => {
  it('claims every alias exactly once across the whole registry', () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];

    for (const cmd of BUILTIN_COMMANDS) {
      for (const key of cmd.keys) {
        const alias = key.trim().toLowerCase();
        const held = owner.get(alias);
        if (held) collisions.push(`"${alias}" is claimed by both ${held} and ${cmd.name}`);
        else owner.set(alias, cmd.name);
      }
    }

    expect(collisions).toEqual([]);
    // Every command is reachable: a shadowed one would be missing from the map.
    const map = buildKeyMap(BUILTIN_COMMANDS);
    expect(new Set(map.values()).size).toBe(BUILTIN_COMMANDS.length);
  });

  it('names only handlers this build actually implements', () => {
    const missing = BUILTIN_COMMANDS.filter((cmd) => cmd.handler && !(cmd.handler in HANDLERS)).map(
      (cmd) => `${cmd.keys[0]} -> ${cmd.handler}`,
    );
    expect(missing).toEqual([]);
  });

  it('gives every command a keyword, a name, a real url and a known category', () => {
    for (const cmd of BUILTIN_COMMANDS) {
      expect(cmd.keys.length, `${cmd.name} has no keys`).toBeGreaterThan(0);
      for (const key of cmd.keys) {
        expect(key, `${cmd.name} has a padded or empty alias`).toBe(key.trim().toLowerCase());
        expect(/\s/.test(key), `${cmd.name} alias "${key}" contains a space`).toBe(false);
      }
      expect(cmd.name.trim().length, `${cmd.keys[0]} has no name`).toBeGreaterThan(0);
      expect(cmd.description.trim().length, `${cmd.keys[0]} has no description`).toBeGreaterThan(0);
      expect(cmd.url.trim().length, `${cmd.keys[0]} has no url`).toBeGreaterThan(0);
      expect(CATEGORIES, `${cmd.keys[0]} has an unknown category`).toContain(cmd.category);
      expect(cmd.builtin, `${cmd.keys[0]} is not flagged builtin`).toBe(true);
    }
  });

  it('ships commands in every category except the fallback one', () => {
    // `custom` is the bucket a user's own shortcuts land in and ships empty by
    // design. Any OTHER empty category is either a typo in the registry or a
    // pack the picker would offer with nothing in it, and both are bugs: a
    // shipped category with no commands is exactly what `media` had become
    // before it was removed in v1.1.0.
    for (const category of CATEGORIES) {
      if (category === 'custom') continue;
      const members = BUILTIN_COMMANDS.filter((cmd) => cmd.category === category);
      expect(members.length, `no command is filed under "${category}"`).toBeGreaterThan(0);
    }
  });

  it('points every url and searchUrl at a scheme go.html will open', () => {
    // `meta` commands are the one exception: they carry an extension-relative
    // path that `toNavigableUrl` expands.
    for (const cmd of BUILTIN_COMMANDS) {
      const relative = cmd.handler === 'meta';
      for (const url of [cmd.url, cmd.searchUrl].filter((value): value is string => !!value)) {
        if (relative && !/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
        expect(url, `${cmd.keys[0]} points at ${url}`).toMatch(/^https?:\/\//);
      }
    }
  });

  it('uses a provider id that exists, and one command per AI provider', () => {
    const ids = new Set(AI_PROVIDERS.map((provider) => provider.id));
    const claimed = new Map<string, string>();
    for (const cmd of BUILTIN_COMMANDS) {
      if (!cmd.provider) continue;
      expect(ids, `${cmd.keys[0]} names provider ${cmd.provider}`).toContain(cmd.provider);
      expect(claimed.has(cmd.provider), `${cmd.provider} is claimed twice`).toBe(false);
      claimed.set(cmd.provider, at(cmd.keys, 0));
    }
    // Every provider the AI handler can pick is reachable by its own keyword.
    for (const provider of AI_PROVIDERS) expect(claimed.has(provider.id)).toBe(true);
  });

  it('gives every search engine a distinct id and a prefix pattern that compiles', () => {
    const ids = SEARCH_ENGINES.map((engine) => engine.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const engine of SEARCH_ENGINES) {
      expect(() => new RegExp(engine.urlPrefixPattern)).not.toThrow();
      expect(engine.urlPrefixPattern).toContain(engine.host.replace(/\./g, '\\.'));
    }
  });
});

/**
 * FREE TEXT NEVER LANDS IN A SHAPED SLOT.
 *
 * A `{q}` that sits in a path segment, an id or a numeric parameter expects a
 * shape: a meeting id, a tracking number, a package name. Words dropped into
 * one of those build a url the site cannot serve: `zoom.us/j/h6%20recorder`,
 * `?trknbr=near%20me%20open%20now`, `localhost/surge%20meaning`. The two tests
 * below run the whole registry, so a command added with an unguarded slot fails
 * here rather than in someone's address bar.
 */
describe('argument slots', () => {
  /** Three nonsense words: no command can shape-match them, none can encode away. */
  const PROBE_WORDS = ['zzqa', 'zzqb', 'zzqc'];
  const PROBE = PROBE_WORDS.join(' ');

  /** Path segments under which free text IS the point, e.g. `/search/{q}`. */
  const SEARCH_SEGMENTS = new Set(['search', 'results']);

  /** Relative meta urls need a base before `URL` will parse them. */
  const BASE = 'chrome-extension://bunnylol/';

  function resolved(cmd: Command): string {
    return resolve(`${cmd.keys[0]} ${PROBE}`, BUILTIN_COMMANDS, DEFAULT_SETTINGS).url;
  }

  /** The path-like parts of a url: its pathname, plus a fragment that is a path. */
  function pathParts(url: string): string[] {
    const parsed = new URL(url, BASE);
    const fragment = parsed.hash.replace(/^#/, '');
    const parts = [decodeURIComponent(parsed.pathname)];
    // `#search/text=…` and `#q=…` are parameter-carrying fragments, not paths.
    if (fragment && !fragment.includes('=')) parts.push(decodeURIComponent(fragment));
    return parts;
  }

  /** True when a probe word sits in a path segment that is not a search endpoint. */
  function holdsProbeInPath(url: string): boolean {
    for (const part of pathParts(url)) {
      const segments = part.split('/').map((segment) => segment.toLowerCase());
      for (const [index, segment] of segments.entries()) {
        if (!PROBE_WORDS.some((word) => segment.includes(word))) continue;
        if (!segments.slice(0, index).some((earlier) => SEARCH_SEGMENTS.has(earlier))) return true;
      }
    }
    return false;
  }

  it.each(BUILTIN_COMMANDS.map((cmd) => [at(cmd.keys, 0), cmd] as const))(
    '%s keeps free text out of a path slot',
    (_key, cmd) => {
      expect(holdsProbeInPath(resolved(cmd))).toBe(false);
    },
  );

  it.each(BUILTIN_COMMANDS.map((cmd) => [at(cmd.keys, 0), cmd] as const))(
    '%s never silently drops its arguments',
    (key, cmd) => {
      // `set` is the exception: the settings route has no field that reads an
      // argument, so `meta` leaves the parameter off rather than building a url
      // the options page ignores.
      //
      // The cloud consoles are a deliberate second exception: their `site:`
      // doc search was removed on request, so they are pure jumps now and
      // arguments have nowhere to go. Listed explicitly so adding a third is a
      // decision someone has to make, not a test that quietly stopped caring.
      const JUMP_ONLY = ['set', 'aws', 'gcp', 'vercel', 'netlify', 'cf'];
      if (JUMP_ONLY.includes(key)) return;
      expect(resolved(cmd).toLowerCase()).toContain(PROBE_WORDS[0]);
    },
  );

  it('starts every example with a keyword the command actually answers to', () => {
    // WolframAlpha shipped `example: 'wa 42 miles in km'` while its only key
    // was `wolfram`, and `wa` belongs to WhatsApp. The browse list prints
    // `example` verbatim under the row, so the page was telling people to type
    // a keyword that opens somebody else's site. Collected rather than run per
    // command: one failure should name every row that drifted.
    const wrong = BUILTIN_COMMANDS.filter((cmd) => {
      const [first = ''] = (cmd.example ?? '').trim().split(/\s+/);
      return first !== '' && !cmd.keys.includes(first);
    }).map((cmd) => `${cmd.keys[0]}: ${cmd.example}`);
    expect(wrong).toEqual([]);
  });

  it('guards every searchUrl that fills a non-query slot with a handler', () => {
    const unguarded: string[] = [];
    for (const cmd of BUILTIN_COMMANDS) {
      if (!cmd.searchUrl?.includes('{q}') || cmd.handler) continue;
      const filled = cmd.searchUrl.split('{q}').join(PROBE_WORDS[0]);
      if (holdsProbeInPath(filled)) unguarded.push(`${cmd.keys[0]} -> ${cmd.searchUrl}`);
    }
    expect(unguarded).toEqual([]);
  });

  it('never turns a misread search into a write', () => {
    // `td bank near me` used to open Todoist's quick-add composer prefilled.
    // Task creation is reachable only through its own alias now.
    const created = BUILTIN_COMMANDS.filter(
      (cmd) => !cmd.keys.includes('tda') && /\/add\b/.test(cmd.searchUrl ?? ''),
    ).map((cmd) => cmd.keys[0]);
    expect(created).toEqual([]);
    expect(resolve('td bank near me', BUILTIN_COMMANDS, DEFAULT_SETTINGS).url).toBe(
      'https://app.todoist.com/app/search/bank%20near%20me',
    );
    expect(resolve('tda buy milk', BUILTIN_COMMANDS, DEFAULT_SETTINGS).url).toBe(
      'https://app.todoist.com/add?content=buy%20milk',
    );
  });
});

/**
 * The browse list's destination line. It reads a row's two url fields, and the
 * options page has no suite of its own, so the rule is tested here against the
 * registry it describes.
 */
describe('destinationOf', () => {
  const builtin = (key: string): Command =>
    BUILTIN_COMMANDS.find((cmd) => cmd.keys.includes(key)) as Command;

  it('shows the search template, because that is where arguments go', () => {
    const dining = builtin('dining');
    expect(dining.searchUrl).toBeTruthy();
    expect(dining.handler).toBeUndefined();
    expect(destinationOf(dining)).toBe(dining.searchUrl);
    expect(destinationOf(builtin('g'))).toBe(builtin('g').searchUrl);
  });

  it('shows the url with no search template to show', () => {
    const gh = builtin('gh');
    expect(gh.searchUrl).toBeUndefined();
    expect(destinationOf(gh)).toBe(gh.url);
  });

  // The tenant url is the field a user at another institution has to edit, and
  // the `site:` template is only what words degrade to: a handler puts a
  // numeric id on the row's own host instead.
  it('shows the tenant url when a handler owns the arguments and the template is a web search', () => {
    for (const key of ['bs', 'gs']) {
      const cmd = builtin(key);
      expect(cmd.handler, key).toBeTruthy();
      expect(cmd.searchUrl, key).toContain('google.com/search');
      expect(destinationOf(cmd), key).toBe(cmd.url);
    }
  });

  it('keeps a handler command whose search is on its own site', () => {
    const cmd: Command = {
      ...builtin('bs'),
      searchUrl: 'https://school.brightspace.com/d2l/search?q={q}',
    };
    expect(destinationOf(cmd)).toBe(cmd.searchUrl);
  });

  it('keeps an engine search that no handler owns', () => {
    const cmd: Command = { ...builtin('bs'), handler: undefined };
    expect(destinationOf(cmd)).toBe(cmd.searchUrl);
  });

  it('keeps an unparseable template rather than hiding it', () => {
    const cmd: Command = { ...builtin('bs'), searchUrl: 'not a url {q}' };
    expect(destinationOf(cmd)).toBe('not a url {q}');
  });
});
