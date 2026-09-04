/**
 * The validation boundary, tested against the contracts it exists to keep: the
 * resolver's "a keyword is one word", the dispatch page's "a destination is a
 * URL we can navigate to", and, for sections, "an id is one canonical token"
 * and "a label is display text a human can actually see". The first two used to
 * be enforced by an emptiness check plus a five-scheme blocklist, which let
 * through an alias that can never match and a `defaultEngine` that is not a URL
 * at all.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../src/lib/commands';
import { AI_PROVIDERS } from '../src/lib/handlers';
import { activeKeywords } from '../src/lib/resolve';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_SETTINGS,
  FORCE_SEARCH_PREFIXES,
} from '../src/lib/types';
import {
  MAX_KEYWORD_LENGTH,
  MAX_SECTION_ID_LENGTH,
  MAX_SECTION_LABEL_LENGTH,
  isInterceptableAlias,
  validateAlias,
  validateSectionId,
  validateSectionLabel,
  validateUrlTemplate,
} from '../src/lib/validate';

function alias(raw: string): string | null {
  const check = validateAlias(raw);
  return check.ok ? check.alias : null;
}

function url(raw: string): string | null {
  const check = validateUrlTemplate(raw);
  return check.ok ? check.url : null;
}

function reason(raw: string): string {
  const check = validateUrlTemplate(raw);
  return check.ok ? '' : check.reason;
}

function sectionId(raw: string): string | null {
  const check = validateSectionId(raw);
  return check.ok ? check.id : null;
}

function idReason(raw: string): string {
  const check = validateSectionId(raw);
  return check.ok ? '' : check.reason;
}

function sectionLabel(raw: string): string | null {
  const check = validateSectionLabel(raw);
  return check.ok ? check.label : null;
}

function labelReason(raw: string): string {
  const check = validateSectionLabel(raw);
  return check.ok ? '' : check.reason;
}

describe('validateAlias', () => {
  it('rejects an alias starting with an escape prefix', () => {
    // Same dead-keyword class as whitespace: resolve() strips the leading
    // escape and plain-searches the remainder, so `=foo` never reaches the key
    // map and the shortcut is unreachable on every surface.
    for (const prefix of FORCE_SEARCH_PREFIXES) {
      const check = validateAlias(`${prefix}foo`);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toContain(prefix);
    }
  });

  it('still accepts an escape character that is not leading', () => {
    expect(validateAlias('a=b')).toEqual({ ok: true, alias: 'a=b' });
  });

  it('accepts a single token and canonicalizes it', () => {
    expect(alias('gh')).toBe('gh');
    expect(alias('  TiX  ')).toBe('tix');
    expect(alias('my-shortcut_2')).toBe('my-shortcut_2');
  });

  /**
   * THE POINT OF THIS FUNCTION. `resolve()` splits the query at the first
   * whitespace, so an alias containing one is not merely awkward: it cannot be
   * typed on any surface, and storing it hides a dead entry in the user's list.
   */
  it.each(['foo bar', 'foo\tbar', 'foo\nbar', 'a b c'])(
    'rejects %j, which can never match',
    (raw) => {
      expect(alias(raw)).toBeNull();
      expect(validateAlias(raw)).toMatchObject({ ok: false });
    },
  );

  it('explains itself well enough to show a user', () => {
    const check = validateAlias('foo bar');
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toMatch(/space/i);
      expect(check.reason).toContain('foo bar');
    }
  });

  it('rejects an empty alias and one past the length cap', () => {
    expect(alias('')).toBeNull();
    expect(alias('   ')).toBeNull();
    expect(alias('x'.repeat(MAX_KEYWORD_LENGTH))).toBe('x'.repeat(MAX_KEYWORD_LENGTH));
    expect(alias('x'.repeat(MAX_KEYWORD_LENGTH + 1))).toBeNull();
  });

  /**
   * Being storable and being interceptable are different questions, and keeping
   * them apart is deliberate: a non-ASCII alias still works from the `bl`
   * omnibox and the popup, it just cannot go into a DNR regex alternation.
   */
  it('keeps an alias the DNR alternation cannot carry', () => {
    expect(alias('日本')).toBe('日本');
    expect(isInterceptableAlias('日本')).toBe(false);
    expect(isInterceptableAlias('gh')).toBe(true);
  });

  it('agrees with activeKeywords about what a rule may carry', () => {
    for (const keyword of activeKeywords(BUILTIN_COMMANDS)) {
      expect(validateAlias(keyword)).toEqual({ ok: true, alias: keyword });
      expect(isInterceptableAlias(keyword)).toBe(true);
    }
  });
});

describe('validateUrlTemplate', () => {
  it('accepts an http(s) URL and returns it with its placeholders intact', () => {
    expect(url('https://kagi.com/search?q={q}')).toBe('https://kagi.com/search?q={q}');
    expect(url('  https://tix.example/  ')).toBe('https://tix.example/');
    expect(url('http://localhost:3000/{q}')).toBe('http://localhost:3000/{q}');
    expect(url('https://example.test/search?q=%s')).toBe('https://example.test/search?q=%s');
  });

  /**
   * The failure the blocklist could not see. `toNavigableUrl` treats anything
   * without a scheme as an extension-relative path, so an unparseable
   * `defaultEngine` does not break one shortcut: it sends every unmatched
   * query to a missing extension resource.
   */
  it('rejects prose, which used to be accepted as a search engine', () => {
    expect(url('not a url')).toBeNull();
    expect(reason('not a url')).toMatch(/not a URL/i);
    expect(url('google.com/search?q={q}')).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>x</script>',
    'vbscript:msgbox(1)',
    'blob:https://example.test/abc',
    'filesystem:https://example.test/temporary/x',
    'mailto:someone@example.test',
    'ftp://files.example.test/pub',
    'file:///etc/passwd',
    'chrome://settings',
  ])('rejects %j', (raw) => {
    expect(url(raw)).toBeNull();
  });

  it('rejects a URL with no host', () => {
    expect(url('https://')).toBeNull();
    expect(url('https://?q={q}')).toBeNull();
  });

  it('rejects an empty template', () => {
    expect(url('')).toBeNull();
    expect(url('   ')).toBeNull();
  });

  /** Everything the extension ships has to pass its own boundary. */
  it('accepts every URL this build ships', () => {
    expect(url(DEFAULT_SETTINGS.defaultEngine)).toBe(DEFAULT_SETTINGS.defaultEngine);
    for (const provider of AI_PROVIDERS) {
      expect(url(provider.template), provider.id).toBe(provider.template);
      expect(url(provider.home), provider.id).toBe(provider.home);
    }
    for (const cmd of BUILTIN_COMMANDS) {
      // The `meta` builtins are the one exception, and deliberately so: they
      // resolve to extension-relative paths (`options.html#help`) that
      // `toNavigableUrl` expands. They ship with the extension and never pass
      // through storage, which is exactly why a scheme-less string reaching
      // this boundary from a file is a bug rather than a feature.
      //
      // Selected by handler, not by category: a shortcut can be moved into any
      // section, but `handler` is never user-editable.
      if (cmd.handler === 'meta') {
        expect(url(cmd.url), cmd.keys[0]).toBeNull();
        continue;
      }
      expect(url(cmd.url), cmd.keys[0]).toBe(cmd.url);
      if (cmd.searchUrl) expect(url(cmd.searchUrl), cmd.keys[0]).toBe(cmd.searchUrl);
    }
    for (const engine of SEARCH_ENGINES) {
      expect(url(`https://${engine.host}/search?q={q}`)).toBeTruthy();
    }
  });
});

describe('validateSectionId', () => {
  it('trims, lowercases and returns the canonical slug', () => {
    expect(sectionId(' Work ')).toBe('work');
    expect(sectionId('MY-STUFF')).toBe('my-stuff');
    expect(sectionId('side-projects-2')).toBe('side-projects-2');
  });

  /**
   * The permissive half of the contract, and the one that is easy to "fix" into
   * a bug: a section whose id IS a builtin category id is not a collision, it
   * is how a shipped category gets renamed. Derived from the registry, not from
   * one name, so a new category that is not a valid section id, and therefore
   * permanently un-renamable, fails here instead of shipping.
   */
  it.each(CATEGORIES)(
    'accepts the shipped category id %s, because that is how a section is renamed',
    (category) => {
      expect(sectionId(category)).toBe(category);
    },
  );

  it('rejects an empty id', () => {
    expect(idReason('')).toMatch(/empty/);
    expect(idReason('   ')).toMatch(/empty/);
  });

  /** Same silent death as an alias with a space: it stores fine and matches nothing. */
  it('rejects an id containing whitespace', () => {
    expect(idReason('my work')).toMatch(/space/);
    expect(sectionId('work\tstuff')).toBeNull();
  });

  it('rejects an id longer than the limit', () => {
    expect(sectionId('x'.repeat(MAX_SECTION_ID_LENGTH))).toBe('x'.repeat(MAX_SECTION_ID_LENGTH));
    expect(idReason('x'.repeat(MAX_SECTION_ID_LENGTH + 1))).toMatch(/32 characters/);
  });

  it.each(['-lead', 'a.b', 'wörk', 'work!', 'my_work', 'u:tix', '2fa/x'])(
    'rejects the non-slug id %j',
    (raw) => {
      expect(sectionId(raw)).toBeNull();
    },
  );

  /**
   * The shape rule is the whole rule: `constructor` is a valid slug and stays
   * one. A consumer that looks an id up in a plain object literal
   * (`CATEGORY_LABELS[id]`) has to use `Object.hasOwn`, because enumerating
   * reserved words here would only cover the ones someone thought of.
   */
  it('accepts a slug that names an Object.prototype member', () => {
    expect(sectionId(' Constructor ')).toBe('constructor');
  });

  it('rejects a non-string, the way the other validators do', () => {
    expect(sectionId(undefined as unknown as string)).toBeNull();
    expect(sectionId(42 as unknown as string)).toBeNull();
  });

  it('always explains itself', () => {
    for (const raw of ['', '   ', 'my work', 'x'.repeat(40), '-lead', 'wörk', 'a.b']) {
      const reasonText = idReason(raw);
      expect(reasonText, raw).not.toBe('');
      expect(reasonText, raw).not.toMatch(/undefined/);
    }
  });
});

describe('validateSectionLabel', () => {
  it('trims and returns the label without lowercasing it', () => {
    expect(sectionLabel('  Work stuff ')).toBe('Work stuff');
    expect(sectionLabel('AI')).toBe('AI');
  });

  /**
   * The mirror of the id sweep, and it buys the same thing on the other half of
   * the pair: renaming a shipped category starts from its current label, so a
   * `CATEGORY_LABELS` value this validator rejects is a row that cannot be
   * saved at its own default. Derived from the registry so a future category
   * whose label breaks the rule fails here instead of shipping.
   */
  it.each(CATEGORIES)(
    'accepts the shipped label for %s, because a rename starts from it',
    (category) => {
      expect(sectionLabel(CATEGORY_LABELS[category])).toBe(CATEGORY_LABELS[category]);
    },
  );

  /** A label is display text, not a key: unicode is the point, not a hazard. */
  it('accepts unicode and punctuation', () => {
    expect(sectionLabel('Wörk ✓')).toBe('Wörk ✓');
    expect(sectionLabel('日常')).toBe('日常');
    expect(sectionLabel('Client / billing')).toBe('Client / billing');
  });

  it('rejects an empty label', () => {
    expect(labelReason('')).toMatch(/empty/);
    expect(labelReason('   ')).toMatch(/empty/);
  });

  it('rejects a label longer than the limit', () => {
    expect(sectionLabel('x'.repeat(MAX_SECTION_LABEL_LENGTH))).toBe(
      'x'.repeat(MAX_SECTION_LABEL_LENGTH),
    );
    expect(labelReason('x'.repeat(MAX_SECTION_LABEL_LENGTH + 1))).toMatch(/40 characters/);
  });

  /**
   * The limit counts what the reason string promises. `.length` counts UTF-16
   * units, so an astral character costs two and the `👨‍💻` sequence five: a
   * 21-emoji label would be refused for being "longer than 40 characters", and
   * the reason string is the only feedback the options and import UIs give.
   */
  it('measures the length in code points, not UTF-16 units', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(sectionLabel(emoji.repeat(MAX_SECTION_LABEL_LENGTH))).toBe(
      emoji.repeat(MAX_SECTION_LABEL_LENGTH),
    );
    expect(labelReason(emoji.repeat(MAX_SECTION_LABEL_LENGTH + 1))).toMatch(/40 characters/);
  });

  /** Invisible in a row of section headings, and it survives into the export file. */
  it('rejects a label with a line break or a control character', () => {
    expect(labelReason('a\nb')).toMatch(/line break/);
    expect(sectionLabel('a\tb')).toBeNull();
    expect(sectionLabel(`a${String.fromCharCode(0x07)}b`)).toBeNull();
    expect(sectionLabel(`a${String.fromCharCode(0x1b)}[31m`)).toBeNull();
    expect(sectionLabel(`a${String.fromCharCode(0x85)}b`)).toBeNull();
  });

  /**
   * The half `\p{Cc}` misses. U+2028/U+2029 are Zl/Zp and render as a forced
   * break inside the heading, the very "contains a line break" case the reason
   * string claims, and `trim()` only strips them at the edges. The zero-width
   * spaces, the BOM and the bidi overrides are Cf and are never trimmed at all.
   */
  it.each([
    ['line separator', `Work${String.fromCharCode(0x2028)}Evil`],
    ['paragraph separator', `Work${String.fromCharCode(0x2029)}Evil`],
    ['zero width space', `a${String.fromCharCode(0x200b)}b`],
    ['right-to-left override', `a${String.fromCharCode(0x202e)}b`],
    ['byte order mark', `Work${String.fromCharCode(0xfeff)}stuff`],
  ])('rejects a label containing a %s', (_name, raw) => {
    expect(sectionLabel(raw)).toBeNull();
    expect(labelReason(raw)).toMatch(/line break or an invisible character/);
  });

  /**
   * A label the user cannot see is a section they cannot find or rename. The
   * joiners are the case `trim()` cannot catch: they are not whitespace, and
   * they are the invisibles `UNPRINTABLE` deliberately keeps. The braille
   * blank, the Hangul fillers and the lone combining mark are not Cf at all, so
   * the unprintable class never sees them either. The no-break space and the
   * BOM are here as regression cover rather than as evidence for `VISIBLE`:
   * `trim()` already empties both, and this says so stays true.
   */
  it.each([
    ['zero width joiner', String.fromCharCode(0x200d)],
    ['zero width non-joiner', String.fromCharCode(0x200c)],
    ['joiners padded with spaces', `${String.fromCharCode(0x200d)} ${String.fromCharCode(0x200d)}`],
    ['no-break space', String.fromCharCode(0x00a0)],
    ['zero width space', String.fromCharCode(0x200b)],
    ['byte order mark', String.fromCharCode(0xfeff)],
    ['braille pattern blank', String.fromCharCode(0x2800)],
    ['hangul filler', String.fromCharCode(0x3164)],
    ['hangul choseong filler', String.fromCharCode(0x115f)],
    ['lone combining acute', String.fromCharCode(0x0301)],
  ])('rejects a label made only of a %s', (_name, raw) => {
    expect(labelReason(raw), _name).toMatch(/empty/);
  });

  /** The one invisible that has to survive: it is what joins an emoji sequence. */
  it('accepts an emoji zero-width joiner sequence', () => {
    const joiner = String.fromCharCode(0x200d);
    const label = `${String.fromCodePoint(0x1f468)}${joiner}${String.fromCodePoint(0x1f4bb)} Dev`;
    expect(sectionLabel(label)).toBe(label);
  });

  /**
   * The other exempt joiner, and the reason the exemption is a pair rather than
   * one character: U+200C is not decoration, it is required orthography: this
   * is Persian for "goes", which is misspelt without it.
   */
  it('accepts a zero-width non-joiner inside a word', () => {
    const label = '\u0645\u06cc\u200c\u0631\u0648\u062f';
    expect(sectionLabel(label)).toBe(label);
  });

  it('rejects a non-string, the way the other validators do', () => {
    expect(sectionLabel(null as unknown as string)).toBeNull();
    expect(sectionLabel({} as unknown as string)).toBeNull();
  });

  it('always explains itself', () => {
    for (const raw of ['', '   ', 'x'.repeat(41), 'a\nb']) {
      const reasonText = labelReason(raw);
      expect(reasonText, raw).not.toBe('');
      expect(reasonText, raw).not.toMatch(/undefined/);
    }
  });
});
