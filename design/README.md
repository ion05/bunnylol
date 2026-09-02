# BunnyLol design system

`tokens.css` is the source of truth for the extension's palette, type scale and metrics.
`src/options/options.css` and `src/popup/popup.css` `@import` it, `tests/tokens.test.ts` parses
it, and `scripts/gen-icons.mjs` reads `--accent` out of it to colour the extension icon. Nothing
else may declare a colour.

Everything else in this directory is the review surface: HTML previews that render the approved
system light and dark, side by side, so a change can be seen before it is implemented.

## Layout

```
tokens.css        the committed source of truth — shipped
components.css    the approved options-page component rules — the contract PR 4/10/11 implement
preview.css       harness only: page chrome, the light/dark columns, spec labels
fonts/            Inter v4.1, the variable woff2 and its OFL licence
foundations/      colours, type, space & radius
components/       buttons, inputs, status, messages
patterns/         topbar-nav, browse, edit-form, settings-sections, welcome, popup, dispatch
```

Each preview's first line is a `<!-- @dsCard group="…" -->` marker; the Design System pane builds
its card index from those.

## The look, in four rules

1. **Flat.** There is no shadow token. Surfaces are separated by a 1px border or by a sunken fill.
   The dispatch toast — the one element that floats — uses a border.
2. **One accent, two tokens.** `--accent: #e1ab76` is a fill and only a fill: it is 2.04:1 on
   white, so it can never be text, a focus ring, or a state indicator in light mode.
   `--accent-text` is the same hue and saturation at half lightness (6.26:1 light, and in dark the
   raw sand is already 9.11:1, so dark needs no separate value). Links, the keyword mark, the
   active-nav underline and the focus ring all use `--accent-text`.
3. **Dim by colour, never by opacity.** An opacity fade takes text below its measured ratio, also
   washes out the switch and the focus ring, and cannot be checked. Rows, disabled buttons and the
   dispatch page all set a colour instead.
4. **State is never colour alone.** The active nav link changes weight *and* gains an underline.
   A turned-off row keeps its outlined `off` badge. Warn and error messages change weight with
   their colour. Invalid inputs get a border, not just a message.

## Light and dark

Tokens are declared once each with `light-dark(light, dark)` and `color-scheme: light dark` on
`:root` — there is no `prefers-color-scheme` block. That is what lets a preview render both
schemes on one page by setting `color-scheme` on a wrapper, and it means the dark palette is never
written down twice. Chrome 123+; this is an MV3 Chrome extension.

Two tokens are deliberately flat rather than pairs:

- `--accent` — the sand is the brand colour in both schemes, and `scripts/gen-icons.mjs` parses
  the literal `--accent: #rrggbb;` declaration.
- `--accent-fg` — `#1a1a1a` on sand is 8.53:1 either way.

### Consequences for `tests/tokens.test.ts` (PR 4)

The A1 spec assumed a media-query split. Two of its cases need a different parse:

```ts
// Was: split the file on the `@media (prefers-color-scheme: dark)` marker.
function tokenValue(css: string, name: string, scheme: 'light' | 'dark'): string {
  const decl = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
  if (!decl) throw new Error(`no --${name} in tokens.css`);
  const pair = /^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(decl);
  return pair ? (scheme === 'light' ? pair[1] : pair[2]) : decl;  // flat tokens are the same in both
}
```

- **Case 1 (light/dark parity)** becomes: every colour token is either a `light-dark()` pair or one
  of the two documented flat tokens. Assert the flat set is exactly `--accent` and `--accent-fg`.
- **Case 18 (go.html uses the token values)** is unchanged in intent — it still drives off
  `tokenValue(tokens, name, scheme)`, which now reads the pair.

Cases 2–17 and 19–23 stand as written.

### One deviation from the A2 spec

The `.select` chevron was specified as two data URIs, light and dark, declared in separate
`prefers-color-scheme` blocks. A data URI cannot resolve `currentColor`, and `light-dark()` takes
colours rather than images, so there is no way to keep the pair without reintroducing a media
query for one rule. It is a single mid grey instead: `#8a8a82`, which is 3.10:1 on the light
`--bg-sunken` and 5.07:1 on the dark one — clearing the 3:1 that WCAG 1.4.11 asks of a control's
affordance in both schemes. This is the only place a colour is inlined outside `tokens.css`;
`tests/tokens.test.ts` should pin the hex.

## Reviewing

**Pattern cards are screens.** Each one renders at the width the product actually uses — the
options shell is 900px — with the light screen above the dark one. Foundations and components are
specimens, so those stay side by side in review columns. Squeezing a 900px screen into a 420px
column makes it read as documentation of a layout rather than as the layout.

Open any preview directly in a browser, or read them in the Claude Design project. The previews
link `../tokens.css`, `../components.css` and `../preview.css`; `preview.css` re-declares the
`@font-face` with a relative URL because `tokens.css` must use the root-absolute `/fonts/` path
that resolves inside a `chrome-extension://` page. Descriptors only — no colour is duplicated.

## Fonts

`fonts/InterVariable.woff2` is Inter v4.1 from https://github.com/rsms/inter/releases/tag/v4.1,
`sha256 693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`, 352,240 bytes, under the
SIL Open Font License 1.1 (`fonts/Inter-OFL.txt`, shipped alongside). The full variable file is
used rather than a latin subset: the official release publishes no subset and subsetting would need
a tool this repo does not depend on. A `unicode-range` limits what is ever rasterised.

The italic file is not shipped — the UI has no italics. `go.html` loads no font at all; it is the
hot path.
