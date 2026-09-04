# Store assets

Chrome Web Store listing assets and copy. `scripts/gen-icons.mjs` generates the icon. Everything
here is uploaded by hand, and none of it is packed into `dist/` or the release zip.

- `icon128.png` the listing icon, which is not the toolbar icon: this one is padded, and the
  toolbar copy in `public/icons/` is deliberately full-bleed.
- `listing.md` the dashboard text. Two of its paragraphs are compliance wording that is quoted
  verbatim from `docs/chrome-web-store.md` and must not be reworded when it is pasted in.
- `../docs/images/welcome.png`, `shortcuts.png` and `editor.png` are the 1280×800 listing
  screenshots. They live with the README so the same files serve both places.
