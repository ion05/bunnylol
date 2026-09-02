/// <reference types="vite/client" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ruleBodies, stripComments, tokenValue } from './helpers/tokens';
import tokens from '../design/tokens.css?raw';
import optionsCss from '../src/options/options.css?raw';
import popupCss from '../src/popup/popup.css?raw';
import goHtml from '../go.html?raw';
import manifestJson from '../public/manifest.json?raw';
import fontsDoc from '../docs/fonts.md?raw';
import designLicence from '../design/fonts/Inter-OFL.txt?raw';
import shippedLicence from '../public/fonts/Inter-OFL.txt?raw';

const SHEETS: Array<[string, string]> = [
  ['options.css', optionsCss],
  ['popup.css', popupCss],
];

/**
 * Every `?raw` import above, so the loader itself is under test. Most of the
 * assertions in this file are negative — `not.toMatch` on a string that never
 * arrived passes — and the CSS ones only survive because vitest.config.ts sets
 * `css: true`. A stub or a moved file has to fail here rather than turn the
 * suite green by emptying it. The smallest of these, go.html, is ~1.8 KB.
 */
const RAW_IMPORTS: Array<[string, string]> = [
  ['design/tokens.css', tokens],
  ['src/options/options.css', optionsCss],
  ['src/popup/popup.css', popupCss],
  ['go.html', goHtml],
  ['public/manifest.json', manifestJson],
  ['docs/fonts.md', fontsDoc],
  ['design/fonts/Inter-OFL.txt', designLicence],
  ['public/fonts/Inter-OFL.txt', shippedLicence],
];

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
    // than a pair; #1a1a1a on it is 8.53:1 either way. The icon is still the
    // legacy indigo — the unit that rewires scripts/gen-icons.mjs onto this
    // declaration is what makes it a parsed dependency.
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
    // 'Opening…', so a font fetch is work the dispatch does not need.
    // PR 11 adds the assertion that go.html's hand-copied hexes match tokens.css.
    expect(goHtml).not.toMatch(/@font-face|Inter|\.woff2/);
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
