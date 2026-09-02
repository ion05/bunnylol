/// <reference types="vite/client" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ruleBodies, ruleIndex, rules, rulesFor, stripComments, tokenValue } from './helpers/tokens';
import { PILL_CLASS } from '../src/options/status';
import tokens from '../design/tokens.css?raw';
import optionsCss from '../src/options/options.css?raw';
import optionsTs from '../src/options/options.ts?raw';
import popupCss from '../src/popup/popup.css?raw';
import goHtml from '../go.html?raw';
import goTs from '../src/go/go.ts?raw';
import manifestJson from '../public/manifest.json?raw';
import genIcons from '../scripts/gen-icons.mjs?raw';
import fontsDoc from '../docs/fonts.md?raw';
import designLicence from '../design/fonts/Inter-OFL.txt?raw';
import shippedLicence from '../public/fonts/Inter-OFL.txt?raw';
// The generator's palette parser, split out of the .mjs so it can be run here.
import { readFlatHex } from '../scripts/lib/tokens.mjs';

const SHEETS: Array<[string, string]> = [
  ['options.css', optionsCss],
  ['popup.css', popupCss],
];

/**
 * Every `?raw` import above, so the loader itself is under test. Most of the
 * assertions in this file are negative — `not.toMatch` on a string that never
 * arrived passes — and the CSS ones only survive because vitest.config.ts sets
 * `css: true`. A stub or a moved file has to fail here rather than turn the
 * suite green by emptying it. The smallest of these, public/manifest.json, is
 * ~1.2 KB.
 */
const RAW_IMPORTS: Array<[string, string]> = [
  ['design/tokens.css', tokens],
  ['src/options/options.css', optionsCss],
  ['src/options/options.ts', optionsTs],
  ['src/popup/popup.css', popupCss],
  ['go.html', goHtml],
  ['src/go/go.ts', goTs],
  ['public/manifest.json', manifestJson],
  ['scripts/gen-icons.mjs', genIcons],
  ['docs/fonts.md', fontsDoc],
  ['design/fonts/Inter-OFL.txt', designLicence],
  ['public/fonts/Inter-OFL.txt', shippedLicence],
];

/**
 * Every module that renders a class name, read as text. A glob rather than a
 * list: a new view added under src/options is swept the day it is written, and
 * src/ui/dom.ts is the shared element helper the options page builds through.
 */
const CLASS_SOURCES: Record<string, string> = {
  ...import.meta.glob('/src/options/**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('/src/ui/dom.ts', { query: '?raw', import: 'default', eager: true }),
};

describe('the fixtures the rest of this file asserts on', () => {
  it.each(RAW_IMPORTS)('%s loaded as text', (_name, raw) => {
    expect(typeof raw).toBe('string');
    expect(raw.length).toBeGreaterThan(500);
  });
});

/** Everything inside tokens.css's single `:root` block, comments removed. */
const rootBlock = (() => {
  const body = /:root\s*\{([\s\S]*?)\n\}/.exec(stripComments(tokens));
  if (!body) throw new Error('tokens.css has no :root block');
  return body[1];
})();

const declarations = [...rootBlock.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => ({
  name: m[1],
  value: m[2].trim(),
}));

describe('design tokens', () => {
  it('declares every colour as a light-dark() pair bar the two documented flat tokens', () => {
    const colours = declarations.filter((d) => d.value.includes('#') || d.value.startsWith('light-dark('));
    expect(colours.length).toBeGreaterThan(10);

    const flat = colours.filter((d) => !d.value.startsWith('light-dark(')).map((d) => d.name);
    // The sand is the brand colour in both schemes, so it is a flat hex rather
    // than a pair; #1a1a1a on it is 8.53:1 either way. Both are parsed by
    // scripts/gen-icons.mjs, which is why neither may become a light-dark()
    // pair: a PNG has one colour, not one per scheme.
    expect(flat.sort()).toEqual(['accent', 'accent-fg']);

    for (const { name } of colours) {
      expect(tokenValue(tokens, name, 'light')).not.toBe('');
      expect(tokenValue(tokens, name, 'dark')).not.toBe('');
    }
  });

  it('uses the sand hex for the accent in both schemes', () => {
    expect(tokenValue(tokens, 'accent', 'light')).toBe('#e1ab76');
    expect(tokenValue(tokens, 'accent', 'dark')).toBe('#e1ab76');
  });

  it('keeps the readable half of the accent for text and the focus ring', () => {
    expect(tokenValue(tokens, 'accent-text', 'light')).toBe('#895420');
    expect(tokenValue(tokens, 'accent-text', 'dark')).toBe('#e1ab76');
    expect(tokenValue(tokens, 'ring', 'light')).toBe('var(--accent-text)');
  });

  it('declares the type scale and nothing between its steps', () => {
    const sizes = declarations.filter((d) => d.name.startsWith('fs-')).map((d) => d.value);
    expect(sizes).toEqual(['11px', '12px', '13px', '14px', '16px', '20px']);
  });

  it('puts Inter first in the sans stack and loads it from the extension root', () => {
    expect(tokens).toMatch(/--font-sans:\s*'Inter',/);
    expect(tokens).toContain("url('/fonts/InterVariable.woff2')");
    expect(tokens).toContain('font-display: swap');
  });

  it('keeps the popup dimensions that each have a recorded reason', () => {
    expect(tokenValue(tokens, 'popup-w', 'light')).toBe('380px');
    expect(tokenValue(tokens, 'popup-list-h', 'light')).toBe('268px');
    expect(popupCss).toMatch(/width:\s*var\(--popup-w\)/);
    expect(popupCss).toMatch(/height:\s*var\(--popup-list-h\)/);
  });
});

describe('the stylesheets are wired to the tokens', () => {
  it.each(SHEETS)('%s imports the tokens as its first statement', (_name, css) => {
    const firstStatement = stripComments(css).trimStart();
    expect(firstStatement.startsWith("@import '../../design/tokens.css';")).toBe(true);
  });

  it.each(SHEETS)('%s never paints the sand accent as text', (_name, css) => {
    // #e1ab76 is 2.04:1 on white and --accent-hover is lighter still, so both
    // are fills. --accent-text is the token for anything that has to be read or
    // has to clear 3:1.
    expect(css).not.toMatch(/(?:^|[^-])color:\s*var\(--accent(?:-hover)?\)/m);
    expect(css).not.toMatch(/outline[^;]*var\(--accent(?:-hover)?\)/);
    expect(css).not.toMatch(/text-decoration[^;]*var\(--accent(?:-hover)?\)/);
    expect(css).not.toMatch(/box-shadow[^;]*var\(--accent(?:-hover)?\)/);
    // `accent-color` is deliberately not swept: it paints a checkbox's fill and
    // the browser draws the check glyph in a contrasting colour itself, so
    // design/components.css's `.check input { accent-color: var(--accent) }`
    // stands. The first regex already skips it — `[^-]` rejects the longhand.
  });

  it.each(SHEETS)('%s only edges a shape with the accent when it also fills it', (_name, css) => {
    // The shorthand draws the same 2.04:1 hairline the longhand does, so both
    // spellings and both fill tokens are matched.
    const edge = /\bborder(?:-(?:top|right|bottom|left))?(?:-color)?:[^;]*var\(--accent(?:-hover)?\)/;
    const fill = /\bbackground(?:-color)?:[^;]*var\(--accent(?:-hover)?\)/;
    for (const body of ruleBodies(css)) {
      if (edge.test(body)) expect(body).toMatch(fill);
    }
  });

  it.each(SHEETS)('%s declares no colour of its own', (_name, css) => {
    // The one literal this check sanctions is the switch knob's ring: the
    // design declares no shadow token, and the ring has to read on both track
    // colours, so it is a shadow of the surface rather than a palette entry.
    // The select chevron is the other literal outside tokens.css; it is
    // percent-encoded, so this regex does not see it and the test below pins it.
    const KNOB_RING = /rgb\(0 0 0 \/ \d+%\)/g;
    expect(stripComments(css).replace(KNOB_RING, '')).not.toMatch(
      /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor\(/,
    );
  });

  it('inlines the palette in exactly one place, the select chevron', () => {
    // A data URI cannot resolve currentColor and light-dark() takes colours
    // rather than images, so the chevron's stroke is one mid grey — 3.10:1 on
    // the light --bg-sunken, 5.07:1 on the dark one. It is percent-encoded
    // rather than a `#` literal, which is why the check above does not see it.
    expect(stripComments(optionsCss).match(/%23[0-9a-fA-F]{3,8}\b/g)).toEqual(['%238a8a82']);
    expect(stripComments(popupCss).match(/%23[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });

  it.each(SHEETS)('%s takes every font weight from the scale', (_name, css) => {
    // 550 and 650 are steps the scale does not have — a variable font draws
    // them happily, which is exactly why they survived unnoticed between
    // --fw-medium and --fw-semibold.
    expect(stripComments(css)).not.toMatch(/font-weight:(?!\s*var\(--fw-)/);
  });

  it.each(SHEETS)('%s sizes every rule from the scale', (_name, css) => {
    expect(css).not.toMatch(/font(?:-size)?:[^;]*\d+\.\d+px/);
    expect(css).not.toMatch(/font-size:\s*\d/);
    expect(css).not.toMatch(/\bfont:[^;]*\d+px/);
    // `font: var(--fs-12)/1.4 …` passes the checks above and still invents a
    // step: the line-height half of the shorthand comes from --lh-* too.
    expect(css).not.toMatch(/\bfont:[^;]*\/\s*\d/);
  });

  it('leaves no trace of the indigo palette in the two stylesheets', () => {
    // Only the two sheets and tokens.css are swept here. #4f46e5 is still the
    // icon background in scripts/gen-icons.mjs, and go.html still carries its
    // own hand-copied indigo; the icon unit and PR 11 take those.
    const legacy = [
      '#5250d8',
      '#4341c0',
      '#eeeefc',
      '#7c7af0',
      '#8b8bf6',
      '#2f5fe0',
      '#8fb0ff',
      '#4f46e5',
      '#c0392b',
      '#ff8f80',
    ];
    for (const hex of legacy) {
      expect(tokens).not.toContain(hex);
      expect(optionsCss).not.toContain(hex);
      expect(popupCss).not.toContain(hex);
    }
  });

  it.each(SHEETS)('%s no longer redeclares the palette in a media query', (_name, css) => {
    expect(css).not.toMatch(/@media\s*\(prefers-color-scheme/);
  });
});

describe('the options page implements the approved component contract', () => {
  const options = stripComments(optionsCss);
  const selectors = new Set(
    rules(optionsCss).flatMap((rule) => rule.selector.split(',').map((one) => one.trim())),
  );

  it('leaves the surfaces flat: nothing sticky, blurred or blended', () => {
    // The topbar was a glass bar pinned to the top of the scroll; the design
    // separates surfaces with a border or a sunken fill and nothing else.
    expect(options).not.toMatch(/position:\s*sticky/);
    expect(options).not.toMatch(/backdrop-filter/);
    // color-mix() hairlines are the other half of the same tell, and a blended
    // border cannot be measured against the thing it sits on.
    expect(options).not.toMatch(/color-mix\(/);
  });

  it('renders the rule status as text plus a dot, with no capsule left behind', () => {
    for (const selector of [
      '.status',
      '.status-dot',
      '.status-ok .status-dot',
      '.status-warn',
      '.status-bad',
      '.status-detail',
    ]) {
      expect(selectors).toContain(selector);
    }
    expect(rulesFor(optionsCss, '.status-dot')).toEqual([expect.stringMatching(/width:\s*6px/)]);
    // The detail only ellipsises if the flex item holding it may shrink: its
    // `min-width: auto` otherwise floors at the width of a `nowrap` line, and
    // the 48ch cap on .status is overflowed rather than applied.
    expect(rulesFor(optionsCss, '.status > span')).toEqual([
      expect.stringMatching(/min-width:\s*0/),
    ]);
    expect(rulesFor(optionsCss, '.status-detail')).toEqual([
      expect.stringMatching(/max-width:\s*100%/),
    ]);
    // Every trace of the tinted pill, in the sheet and in the seam that names
    // the classes for it.
    expect(options).not.toMatch(/\.pill/);
    expect(Object.values(PILL_CLASS).join(' ')).not.toContain('pill');
  });

  it('takes the row height from the token rather than from padding', () => {
    // Two entries: the rule and the narrow-viewport override that only reshapes
    // the grid. The height belongs to the first.
    const [row, narrow] = rulesFor(optionsCss, '.row');
    expect(row).toMatch(/min-height:\s*var\(--row-h\)/);
    expect(row).not.toMatch(/height:\s*\d/);
    expect(narrow).not.toMatch(/height:/);
  });

  it('dims a disabled button by colour, never by opacity', () => {
    // A fraction of whatever happens to be behind the control is not a colour
    // anyone can measure or theme; --text-faint on --border-strong is.
    const [disabled, ...more] = rulesFor(optionsCss, '.btn:disabled');
    expect(more).toEqual([]);
    expect(disabled).toMatch(/color:\s*var\(--text-faint\)/);
    expect(disabled).toMatch(/border-color:\s*var\(--border-strong\)/);
    expect(disabled).toMatch(/opacity:\s*1/);
  });

  it('reveals a row’s actions without taking them out of the tab order', () => {
    // `visibility` and `display` would drop the buttons from the tab order, so
    // a keyboard user could reach a row and find nothing on it.
    const [hidden, coarse] = rulesFor(optionsCss, '.row-actions .btn');
    expect(hidden).toMatch(/opacity:\s*0;/);
    expect(selectors).toContain('.row:focus-within .row-actions .btn');
    // A coarse pointer has nothing to hover with, so there is nothing to reveal.
    expect(options).toMatch(/@media \(hover: none\)/);
    expect(coarse).toMatch(/opacity:\s*1/);
    // The cards whose only reason to exist is their buttons opt back out.
    expect(rulesFor(optionsCss, '.section-row .row-actions .btn')).toEqual([
      expect.stringMatching(/opacity:\s*1/),
    ]);
    expect(rulesFor(optionsCss, '.restore-rows .row-actions .btn')).toEqual([
      expect.stringMatching(/opacity:\s*1/),
    ]);
  });

  it('has a rule for every class the options TypeScript renders', () => {
    // The classes the page paints itself with are only in the TypeScript, so a
    // rule deleted from this sheet leaves no trace at all in it — `.panel-head`
    // lost its `.panel-head-text` companion that way, and seven panel heads
    // silently stacked their title, sub-line and Saved chip with no gap.
    const CLASS_LITERAL = /(?:\bclass|\bclassName)\s*[:=]\s*'([^']*)'/g;
    // Tokens rendered for something other than a rule of their own. Each entry
    // needs a reason here; anything else missing is a bug.
    const NO_RULE_OF_ITS_OWN = [
      // The section wrapper a `.group-head` and its `.rows` sit in. It is a
      // grouping box and a `hidden` target, and the flex column that spaces it
      // belongs to `.groups`; the contract's `border-bottom: 0` on it was
      // undoing a border this sheet no longer draws.
      'group',
    ];

    expect(Object.keys(CLASS_SOURCES).length).toBeGreaterThan(8);
    const rendered = new Map<string, string>();
    for (const [file, source] of Object.entries(CLASS_SOURCES)) {
      for (const [, list] of source.matchAll(CLASS_LITERAL)) {
        for (const token of list.trim().split(/\s+/)) if (token) rendered.set(token, file);
      }
    }
    expect(rendered.size).toBeGreaterThan(50);
    expect([...rendered.keys()]).toContain('panel-head-text');

    const styled = new Set(
      [...selectors].flatMap((one) =>
        [...one.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]),
      ),
    );
    const orphans = [...rendered]
      .filter(([token]) => !styled.has(token) && !NO_RULE_OF_ITS_OWN.includes(token))
      .map(([token, file]) => `.${token} (${file})`);
    expect(orphans).toEqual([]);
  });

  it('declares the button rules in the order their cascade depends on', () => {
    // Every one of these is exactly as specific as the next, so the sheet's
    // order is the whole of the resolution: `.btn:disabled` last, or a disabled
    // Reset lights up under the pointer; `.btn-armed:hover` after the ghost and
    // danger hovers, or the red confirm fill is washed away by the pointer that
    // is about to click it.
    const hovers = [...selectors].filter((one) => /^\.btn(?:-[a-z]+)?:hover$/.test(one));
    expect(hovers).toEqual(
      expect.arrayContaining(['.btn:hover', '.btn-ghost:hover', '.btn-danger:hover', '.btn-armed:hover']),
    );

    const disabled = ruleIndex(optionsCss, '.btn:disabled');
    expect(disabled).toBeGreaterThan(-1);
    for (const hover of hovers) {
      expect([hover, disabled > ruleIndex(optionsCss, hover)]).toEqual([hover, true]);
    }

    const armed = ruleIndex(optionsCss, '.btn-armed:hover');
    expect(armed).toBeGreaterThan(ruleIndex(optionsCss, '.btn-ghost:hover'));
    expect(armed).toBeGreaterThan(ruleIndex(optionsCss, '.btn-danger:hover'));
  });

  it('states a message with colour and weight, not with a bar or an icon', () => {
    // `.msg::before` drew a 3px rule down the left of every message. The tone is
    // the colour and the weight, the wording is the meaning, and an invalid
    // input already carries its own red border — the bar was a second thing to
    // keep in sync that said nothing the message did not.
    expect(options).not.toMatch(/\.msg::(?:before|after)/);
    const [msg, ...more] = rulesFor(optionsCss, '.msg');
    expect(more).toEqual([]);
    expect(msg).toMatch(/display:\s*block/);
    // Colour alone would be the whole signal otherwise. Both tones that mean
    // something went wrong carry the weight; `.msg-ok` is the absence of a
    // problem and has nothing to state twice.
    for (const selector of ['.msg-error', '.msg-warn']) {
      expect([selector, rulesFor(optionsCss, selector)]).toEqual([
        selector,
        [expect.stringMatching(/font-weight:\s*var\(--fw-medium\)/)],
      ]);
    }
  });

  it('outlines the blocks on the form, settings and data routes instead of tinting them', () => {
    // Every one of these was a tint: the preview and the import choice sat on
    // --bg-raised behind a color-mix(--accent 30%) hairline, and the danger zone
    // was a red box. A block is a 1px border on the sunken fill, or on nothing.
    for (const [selector, fill] of [
      ['.preview', 'var(--bg-sunken)'],
      ['.import-choice', 'var(--bg-sunken)'],
      ['.code-block', 'var(--bg-sunken)'],
      ['.escape', 'var(--bg-sunken)'],
      ['.danger-zone', 'none'],
    ] as const) {
      const [rule, ...extra] = rulesFor(optionsCss, selector);
      expect([selector, extra]).toEqual([selector, []]);
      expect([selector, rule]).toEqual([
        selector,
        expect.stringMatching(new RegExp(`background:\\s*${fill.replace(/[()-]/g, '\\$&')}`)),
      ]);
      expect([selector, rule]).toEqual([
        selector,
        expect.stringMatching(/border:\s*1px solid var\(--border(?:-strong)?\)/),
      ]);
    }
    // There is no -soft companion to build a tinted surface out of.
    expect(options).not.toMatch(/--(?:accent|ok|warn|danger|bg)-soft/);
  });

  it('names the wide field the way the contract does', () => {
    // The contract's modifier is `.field.wide`; the sheet carried `.field-wide`,
    // which is a different class and would have gone on styling nothing the day
    // a view was written against the contract's markup instead.
    expect(selectors).toContain('.field.wide');
    expect(options).not.toContain('.field-wide');
    for (const [file, source] of Object.entries(CLASS_SOURCES)) {
      expect([file, source.includes('field-wide')]).toEqual([file, false]);
    }
  });

  it('has no shim or dead rule left from the pre-contract vocabulary', () => {
    // `.badge-mod` existed only to undo the old uppercase `.badge`; `.brand-tag`
    // was the lowercase tagline under the wordmark.
    for (const gone of ['.badge-mod', '.brand-tag']) {
      expect(options).not.toContain(gone);
    }
    expect(optionsTs).not.toContain('brand-tag');
    // The -soft companions were the tinted status backgrounds; the design has
    // no tinted surface at all.
    expect(options).not.toMatch(/--(?:accent|ok|warn|danger|bg)-soft/);
  });
});

describe('the popup implements the approved component contract', () => {
  const popup = stripComments(popupCss);

  it('keeps a focus indicator on the query input', () => {
    // The input was `outline: none` plus a 3px --accent-soft box-shadow standing
    // in for a ring. A negative offset draws a real outline inside the control,
    // so it cannot be clipped at the popup's edge and cannot shift its metrics.
    expect(popup).not.toMatch(/outline:\s*none/);
    expect(rulesFor(popupCss, '.query:focus-visible')).toEqual([
      expect.stringMatching(/outline:\s*2px solid var\(--ring\)/),
    ]);
    expect(rulesFor(popupCss, '.query:focus-visible')).toEqual([
      expect.stringMatching(/outline-offset:\s*-2px/),
    ]);
  });

  it('sizes its rows from the token and marks the keyword with the readable accent', () => {
    const [row, ...more] = rulesFor(popupCss, '.row');
    expect(more).toEqual([]);
    expect(row).toMatch(/min-height:\s*var\(--row-h-popup\)/);
    // A neutral recessed fill, not an accent tint: the list sits on --bg.
    expect(rulesFor(popupCss, '.row.is-selected')).toEqual([
      expect.stringMatching(/background:\s*var\(--bg-sunken\)/),
    ]);
    // The keyword highlight is the one place the accent is text here, and the
    // UA's yellow <mark> fill has to go for --accent-text to be what is read.
    const [mark, ...extra] = rulesFor(popupCss, '.row-key mark');
    expect(extra).toEqual([]);
    expect(mark).toMatch(/background:\s*none/);
    expect(mark).toMatch(/color:\s*var\(--accent-text\)/);
  });
});

describe('the bundled font', () => {
  // `?raw` would decode the woff2 as UTF-8, which folds every invalid byte into
  // U+FFFD and so misses roughly two in five single-byte differences. The suite
  // runs in the node environment, so hash the actual bytes instead.
  const sha256 = async (path: string): Promise<string> => {
    const bytes = readFileSync(new URL(path, import.meta.url));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  it('is byte-identical to the copy the design previews render with', async () => {
    expect(await sha256('../public/fonts/InterVariable.woff2')).toBe(
      await sha256('../design/fonts/InterVariable.woff2'),
    );
    expect(shippedLicence).toBe(designLicence);
  });

  it('is the release docs/fonts.md records', async () => {
    // Pins the provenance as well as the parity: without this the two copies
    // could be updated together and the documented sha256 rot unnoticed.
    const recorded = /^\| sha256 \| `([0-9a-f]{64})` \|$/m.exec(fontsDoc);
    expect(recorded).not.toBeNull();
    expect(await sha256('../public/fonts/InterVariable.woff2')).toBe(recorded?.[1]);
  });

  it('never reaches the dispatch page', () => {
    // go.html is the hot path: go.ts budgets 150ms before it will even reveal
    // 'Opening…', so a font fetch is work the dispatch does not need. The
    // describe below pins the rest of that page against the tokens.
    expect(goHtml).not.toMatch(/@font-face|Inter|\.woff2/);
  });
});

describe('the dispatch page', () => {
  /**
   * go.html cannot `@import` the tokens: its whole job is to redirect before it
   * is seen, so the sheet is inline and the values are copied by hand. Each
   * colour is pinned to the token it was copied from, in both schemes, so
   * editing tokens.css alone turns this red — which is the only thing standing
   * between the two files and silent drift.
   */
  const HAND_COPIED: Array<[string, string]> = [
    ['bg', 'the page'],
    ['text', 'body copy, the toast and the hovered dismiss button'],
    ['text-dim', 'the status line, the typed echo and the dismiss button'],
    ['text-faint', 'the explanation under the echo'],
    ['bg-raised', 'the toast fill'],
    ['border-strong', 'the toast edge'],
  ];

  /**
   * The values that are not colours were copied by hand too — the type scale,
   * the weights, the radius and the spacing steps — and nothing about `24px`
   * says which token it came from. Each entry names the token, the value
   * tokens.css declares, and the declaration go.html spent it on, built from
   * that same value so the two cannot be edited apart.
   */
  const HAND_COPIED_SCALARS: Array<[string, string, (value: string) => string]> = [
    ['fs-13', '13px', (v) => `font:${v}/1.45`],
    ['lh-body', '1.45', (v) => `font:13px/${v}`],
    ['sp-9', '32px', (v) => `padding:${v} 24px`],
    ['sp-8', '24px', (v) => `padding:32px ${v}`],
    ['sp-1', '2px', (v) => `gap:${v};`],
    ['radius-2', '6px', (v) => `border-radius:${v};`],
    ['fs-12', '12px', (v) => `font-size:${v};`],
    ['fs-16', '16px', (v) => `.err-title{font-size:${v};`],
    ['fw-semibold', '600', (v) => `font-weight:${v};`],
    ['sp-5', '12px', (v) => `gap:${v}}`],
  ];

  const squashed = goHtml.replace(/\s+/g, '');
  /** The rules run over several lines; a declaration's own spacing is kept. */
  const collapsed = goHtml.replace(/\s+/g, ' ');

  it.each(HAND_COPIED)('writes --%s as the pair tokens.css declares (%s)', (name) => {
    const light = tokenValue(tokens, name, 'light');
    const dark = tokenValue(tokens, name, 'dark');
    expect(light).not.toBe(dark);
    expect(squashed).toContain(`light-dark(${light},${dark})`);
  });

  it.each(HAND_COPIED_SCALARS)('spends --%s where tokens.css puts %s', (name, literal, use) => {
    // A scale step is flat in both schemes, so a pair here would be a token that
    // had quietly become something a hand-copied literal cannot stand for.
    expect(tokenValue(tokens, name, 'light')).toBe(literal);
    expect(tokenValue(tokens, name, 'dark')).toBe(literal);
    expect(collapsed).toContain(use(literal));
  });

  it('copies no colour tokens.css does not declare', () => {
    // The other direction: a hex nobody named is a colour that was invented
    // here, and light-dark() means the pair above cannot cover only one scheme.
    const declared = new Set(
      declarations.flatMap(({ name }) => [
        tokenValue(tokens, name, 'light').toLowerCase(),
        tokenValue(tokens, name, 'dark').toLowerCase(),
      ]),
    );
    const used = goHtml.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(used.length).toBeGreaterThanOrEqual(HAND_COPIED.length * 2);
    for (const hex of used) {
      expect([hex, declared.has(hex.toLowerCase())]).toEqual([hex, true]);
    }
  });

  it('floats its one floating element on a border, not a shadow', () => {
    // There is no shadow token to build one from, in either scheme.
    expect(goHtml).not.toMatch(/box-shadow/);
    expect(squashed).toContain('border:1pxsolidlight-dark(');
  });

  it('dims by colour rather than by opacity', () => {
    // `opacity: .6` on the status line and `.65` on the error explanation were
    // unmeasurable fractions of whatever was behind them; --text-dim and
    // --text-faint are colours with recorded ratios.
    expect(stripComments(goHtml)).not.toMatch(/opacity:/);
  });

  it('styles the error page by class rather than by cssText', () => {
    // Five inline `style.cssText` strings meant the dispatch page could not be
    // restyled without editing TypeScript, and none of them were tokens.
    expect(goTs).not.toContain('style.cssText');
    expect(goTs).not.toMatch(/\.style\.[a-zA-Z]+\s*=/);
    for (const name of ['err-title', 'err-echo', 'err-why', 'err-actions', 'go-link', 'err-fallback']) {
      expect([name, goTs.includes(`'${name}'`)]).toEqual([name, true]);
      expect([name, goHtml.includes(`.${name}{`)]).toEqual([name, true]);
    }
  });
});

describe('the extension icon', () => {
  /** A hex from tokens.css as [r, g, b]. */
  const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  const uint32 = (bytes: Uint8Array, at: number): number =>
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

  /**
   * Reads the pixels of a PNG this repo generated: one IDAT, no interlacing,
   * filter byte 0 on every scanline, straight (un-premultiplied) alpha.
   * Asserting on the generator's source is not asserting on the icon — these
   * bytes are what ships, and nothing in `pnpm test` regenerates them.
   *
   * Inflated through DecompressionStream rather than node:zlib because this
   * repo has no @types/node and takes no new dependency to get one; 'deflate'
   * is the zlib wrapper an IDAT carries.
   */
  const pixels = async (path: string): Promise<(x: number, y: number) => number[]> => {
    const png = readFileSync(new URL(path, import.meta.url));
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let width = 0;
    for (let at = 8; at < png.length; ) {
      const length = uint32(png, at);
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
      const body = png.subarray(at + 8, at + 8 + length);
      if (type === 'IHDR') width = uint32(body, 0);
      if (type === 'IDAT') parts.push(body);
      at += 12 + length;
    }
    const inflating = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
    const raw = new Uint8Array(await new Response(inflating).arrayBuffer());
    const stride = width * 4;
    return (x, y) => {
      expect(raw[y * (stride + 1)]).toBe(0);
      const start = y * (stride + 1) + 1 + x * 4;
      return [...raw.subarray(start, start + 4)];
    };
  };

  it('reads both of its colours from tokens.css', () => {
    // The indigo tile and the white glyph were literals in this script, which
    // is how the icon stayed indigo through a whole palette change.
    expect(genIcons).toContain("join(root, 'design', 'tokens.css')");
    expect(genIcons).toMatch(/readFlatHex\(\w+, '--accent'\)/);
    expect(genIcons).toMatch(/readFlatHex\(\w+, '--accent-fg'\)/);
    expect(genIcons).not.toMatch(/0x4f, 0x46, 0xe5/);
    expect(genIcons).not.toMatch(/const (?:BG|FG) = \[/);
  });

  it('takes the palette apart the way the icon needs it, and refuses otherwise', () => {
    // The generator's own parser, run rather than read: it only ever meets the
    // real tokens.css, where neither refusal below can be reproduced without
    // editing the palette. Both are the same answer — a PNG has one colour, not
    // one per scheme, and no colour at all is not a colour to guess at.
    expect(readFlatHex(tokens, '--accent')).toEqual(rgb(tokenValue(tokens, 'accent', 'light')));
    expect(readFlatHex(':root { --accent: #e1ab76; }', '--accent')).toEqual([0xe1, 0xab, 0x76]);
    expect(() => readFlatHex(':root { --accent: light-dark(#e1ab76, #e1ab76); }', '--accent')).toThrow(
      /--accent/,
    );
    // The colon has to follow the name, or --accent-text answers for --accent.
    expect(() => readFlatHex(':root { --accent-text: #895420; }', '--accent')).toThrow(/--accent/);
  });

  it('paints the committed PNGs in those colours', async () => {
    const accent = rgb(tokenValue(tokens, 'accent', 'light'));
    const glyph = rgb(tokenValue(tokens, 'accent-fg', 'light'));
    const toolbar = await pixels('../public/icons/icon128.png');
    const store = await pixels('../store/icon128.png');
    for (const [name, pixel] of [['toolbar', toolbar], ['store', store]] as const) {
      // The tile above the ears, then the middle of the rabbit's head.
      expect([name, pixel(64, 19)]).toEqual([name, [...accent, 255]]);
      expect([name, pixel(64, 90)]).toEqual([name, [...glyph, 255]]);
    }
    // The store tile is the same art at 96px centred in a 128px frame, so it
    // has 16px of nothing around it where the toolbar icon is full bleed.
    expect(store(8, 64)).toEqual([0, 0, 0, 0]);
    expect(toolbar(8, 64)).toEqual([...accent, 255]);
  });
});

describe('the manifest floor', () => {
  it('is at least the Chrome that shipped light-dark()', () => {
    // Every colour token is a light-dark() pair, and a var() that resolves to a
    // colour function the engine cannot parse is invalid at computed-value time
    // — the property becomes `unset`, so backgrounds go transparent and the
    // switch's off state disappears. light-dark() shipped in Chrome 123.
    expect(tokens).toContain('light-dark(');
    const floor = Number(JSON.parse(manifestJson).minimum_chrome_version);
    expect(floor).toBeGreaterThanOrEqual(123);
  });
});
