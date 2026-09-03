# Chrome Web Store submission

Everything the dashboard asks for, written down once, so a submission is a copy-paste rather than a
fresh act of composition. The strings below are the answers, word for word. If the code stops
matching one of them, change the code or change this file. Do not soften a justification to fit.

This repo produces the manifest, the release zip (`pnpm package`), the privacy policy
([PRIVACY.md](../PRIVACY.md)), the listing icon (`store/icon128.png`) and the listing copy
([store/listing.md](../store/listing.md)). It does not produce screenshots. See
[Assets](#assets).

## Category

**Productivity** (Workflow & Planning).

## Single purpose

> Resolve user-defined keyword shortcuts typed into the address bar into their destination URL.

## Permission justifications

One per declared permission, in the order the dashboard lists them.

**`storage`**

> Stores the user's keyword shortcuts and settings locally on the device (chrome.storage.local);
> nothing is uploaded.

**`declarativeNetRequest`**

> Registers dynamic redirect rules that rewrite an address-bar search on the three supported
> engines into the extension's local dispatch page, so a typed keyword resolves without any request
> reaching the search engine.

**Host permissions**: `https://www.google.com/*`, `https://www.bing.com/*`,
`https://duckduckgo.com/*`

> declarativeNetRequest redirect rules only apply to URLs the extension has host access to.
> www.google.com, www.bing.com and duckduckgo.com are the only engines whose result URLs are
> rewritten; no content scripts are injected and no page content is read.

`omnibox` is a manifest key, not a permission. The dashboard will not ask about it, and it does not
appear on the install prompt.

`tests/manifest.test.ts` pins the declared list. It derives the host permissions from
`SEARCH_ENGINES` rather than restating them. Adding a permission fails that test first, which is the
point: a new permission is a new review.

## Remote code

**No.**

Evidence, if review challenges it: there is no `eval`, no `new Function`, no `importScripts`, and no
CDN or other remote script reference anywhere in `src/`, `go.html`, `options.html` or `popup.html`.
There is no `fetch` or `XMLHttpRequest` of any kind. The only bundled binary assets are the icons
and one self-hosted font (`public/fonts/InterVariable.woff2`, see [fonts.md](fonts.md)). Everything
that runs ships in the package.

## Privacy practices

- **Data collection:** tick nothing. The extension collects, transmits and stores nothing off the
  device. The whole persisted state is one JSON value under `bunnylol.state.v1` in
  `chrome.storage.local`, plus a session-lifetime rule-status cache in `chrome.storage.session`.
- **Limited use:** certify all three statements. Nothing is sold, transferred or used for anything
  but the single purpose above, because nothing leaves the machine.
- **Privacy policy URL:** `https://github.com/ion05/bunnylol/blob/master/PRIVACY.md`. The field
  requires a URL rather than a file, and the dashboard accepts that one, so hosting a copy on
  GitHub Pages just to satisfy it is not worth doing.

## Search-behaviour disclosure

Undisclosed modification of search behaviour is a rejection trigger, and this extension does rewrite
search navigations. Put this in the listing's detailed description. The wording is fixed here so it
cannot be softened later:

> BunnyLol does not change your default search engine. It watches address-bar navigations to
> Google, Bing and DuckDuckGo and, when the first word of what you typed matches one of your
> keywords, redirects locally to the extension's own dispatch page instead of loading the results
> page. Everything else searches normally. Put \ or = in front of anything you want searched as
> plain text. Interception can be turned off per engine, or entirely, in the extension's settings.

## Non-affiliation

Also in the detailed description:

> BunnyLol is an independent, unofficial project inspired by a bunnylol-style command bar. Not
> affiliated with, endorsed by, or sponsored by Meta Platforms, Inc.

Avoid the word "clone" in listing copy specifically. It invites the impersonation read that the line
above exists to close. Have a fallback name ready in case review objects to the name itself.

## Assets

- **Listing icon:** `store/icon128.png`. It is the same art as the toolbar icon at 96px, centred in
  a 128px frame. `public/icons/icon128.png` is deliberately full-bleed for the toolbar and looks
  wrong on a listing card. `scripts/gen-icons.mjs` generates both. `store/` sits outside `public/`,
  so it is never copied into `dist/` or the release zip.
- **Screenshots are a hard submission blocker, and this repo does not produce them.** At least one
  1280x800 PNG is required. A suggested set: the address bar mid-type, the options page showing the
  shortcut list with a group folded, the edit form with its live preview, and the toolbar popup. Do
  not plan a shot around the rule-status pill: it is silent on a healthy profile, so there is
  nothing to capture. A 440x280 small promo tile is needed to be eligible for featuring.
- Keep every listing asset out of `dist/`, so none of it reaches the upload.

## Upload checklist

1. Bump `version` in `public/manifest.json` **and** `package.json` in the same commit
   (`tests/manifest.test.ts` fails if they disagree). The store requires each upload to be strictly
   higher than the last.
2. Add the release to `CHANGELOG.md`.
3. `pnpm typecheck && pnpm test && pnpm build`.
4. `pnpm package` → `release/bunnylol-<version>.zip`.
5. Confirm the zip: `unzip -l release/bunnylol-<version>.zip` must show `manifest.json` at the top
   level with no `dist/` prefix, and no `*.map` entry anywhere.
6. Upload that zip. Paste the single-purpose statement, the permission justifications, and the
   two paragraphs above into the listing and the privacy tab.

## Known review risks

| Risk | Mitigation |
|---|---|
| The extension rewrites search-engine navigations | The disclosure paragraph above, plus per-engine and global off switches in Settings |
| The name is Meta-adjacent | The non-affiliation line, and no use of "clone" in listing copy |
| A first interception with no explanation attached | The first-run picker states the first-word rule and the escape prefixes before any shortcut fires |

## Appendix: not in scope, drafted because review will ask

The two paragraphs under [Search-behaviour disclosure](#search-behaviour-disclosure) and
[Non-affiliation](#non-affiliation) are listing copy, which this repo deliberately does not own.
They are written out here for two reasons. Both are answers to questions that manual review reliably
asks. And both are claims about how the code behaves: the first word of an address-bar query is
always a command when it matches a registered keyword, a leading `\` or `=` forces a plain search,
and interception is per-engine. Someone answering review under time pressure should not have to
re-derive them from `src/lib/resolve.ts`.
