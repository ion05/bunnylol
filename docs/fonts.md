# Bundled fonts

The UI ships one font file. It is bundled rather than fetched, so the extension makes no network
request to render its own pages. That is what `PRIVACY.md` promises, and it is what a Chrome Web
Store review expects of a "no remote code" extension.

## Inter

| | |
|---|---|
| Family | Inter |
| Release | v4.1, <https://github.com/rsms/inter/releases/tag/v4.1> |
| File taken | `web/InterVariable.woff2` from `Inter-4.1.zip` |
| Shipped as | `public/fonts/InterVariable.woff2` |
| Size | 352,240 bytes |
| sha256 | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| Licence | SIL Open Font License 1.1, text in `public/fonts/Inter-OFL.txt` |

`public/` is Vite's publicDir, so the file is copied verbatim to `dist/fonts/`, the same way
`public/icons/` already ships. `design/tokens.css` declares the `@font-face` with the root-absolute
URL `/fonts/InterVariable.woff2`. Vite leaves root-absolute `url()` alone, and on a
`chrome-extension://` page it resolves to the extension root.

`InterVariable-Italic.woff2` is deliberately **not** shipped, because the UI has no italics.
`go.html` loads no font at all. It is the dispatch hot path, and a font fetch, even a local one, is
work it does not need.

### Licence obligations

OFL-1.1 requires that the licence text travel with the font, and that the font is not sold on its
own. `public/fonts/Inter-OFL.txt` is the unmodified `LICENSE.txt` from the release. It is copied
into `dist/` alongside the woff2, so an installed extension carries it. The font is unmodified, so
the Reserved Font Name clause does not bite.

### Why the whole variable file and not a Latin subset

352 KB is large for what the UI actually draws. But the official release publishes no subset, and
subsetting would need a tool (`fonttools`/`pyftsubset` or `subset-font`) that this repo does not
depend on. The repo's rule is no new dependencies. Instead the `@font-face` in `design/tokens.css`
carries the standard Latin `unicode-range`, so the browser rasterises that range and leaves the rest
of the file idle on disk.

That range is not a description of what the UI draws. Two glyphs the UI renders fall outside it. So
they repaint mid-string in the system fallback, at a different weight and baseline from the Inter
around them:

- `→` (U+2192): the popup destination arrow, the options live preview, and the merge-import rename
  summary. The range includes the adjacent U+2191 and U+2193, but not this one.
- `⌘` (U+2318): the popup footer hint `Tab completes · ⌘/Ctrl+Enter new tab`.

Adding `U+2192, U+2318` to the range is a one-line change to `design/tokens.css`. That is the
approved bundle, and it is not edited outside a design change. So raise it with the design owner, or
drop the two glyphs from the UI copy when the popup and options are restyled.

If subsetting is ever worth it, do it as a checked-in artefact with the command recorded here, not
as a build step.

## Keeping the two copies identical

The font exists twice on purpose:

- `design/fonts/`, so `design/`'s previews render standalone in a browser, with no build.
- `public/fonts/`, so the extension ships it.

They must stay byte-identical. `tests/tokens.test.ts` asserts that by sha256-ing the bytes of both
files. It also asserts that the shipped copy hashes to the value recorded in the table above. So
neither the drift that actually happens (one copy updated to a new Inter release and the other left
behind) nor a silent edit to both can pass. Update the table when the release changes: the test
reads the hash straight out of it.

### Known issue in the design previews

The previews do not actually render in Inter yet. `design/preview.css` line 15 declares the harness
`@font-face` as `src: url('../fonts/InterVariable.woff2')`, and a relative `url()` resolves against
the stylesheet's own URL. So from `design/preview.css` it points at `<repo>/fonts/InterVariable.woff2`,
which does not exist. The font is at `design/fonts/`. Every page under `design/foundations`,
`design/components` and `design/patterns` therefore falls back to the system font, and no preview
reads the `design/fonts/` copy above. (The `@font-face` in `design/tokens.css` is root-absolute,
`/fonts/…`, which is correct for a `chrome-extension://` page and cannot resolve from a `file://`
preview. That is why `preview.css` redeclares it.)

`design/` is the approved bundle and is not edited outside a design change. The design owner should
change that line to `url('fonts/InterVariable.woff2')`. Nothing the extension ships is affected:
this is the review surface only.
