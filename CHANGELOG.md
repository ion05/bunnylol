# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-09-02

### Added

- `track <number>` (also `pkg`): one keyword for any parcel. BunnyLol reads
  the carrier (UPS, USPS, FedEx or DHL) off the shape of the number and opens
  that carrier's own tracking page. A number nobody recognises is searched
  for instead. A `dhl` shortcut joins `ups`, `fedex` and `usps`.
- **Start over**, in Settings → Data. It erases every shortcut, edit,
  section and setting, then runs the first-install setup again and opens the
  welcome screen, so the profile ends up exactly as a fresh install leaves it.
  Two clicks, the second one confirming.
- A first-run picker. Installing now opens a welcome screen that asks which
  packs of shipped shortcuts you want, and each pack unfolds to list the
  shortcuts a tick turns on. Search, Developer and AI are ticked. Every other
  pack is offered unticked, and its shortcuts start switched off: Google,
  Microsoft, Social, Productivity, and Purdue under "Optional packs". The
  screen states the first-word rule and the escape prefixes before any
  shortcut can surprise you, and closing the tab keeps the ticked set. A
  **Shortcut packs** screen in Settings asks the same question again later.
- One edit form for every shortcut. Shipped shortcuts and your own now have
  the same actions, an Edit icon and a Delete icon then the on/off switch,
  and the same form. Reset refills that form from the shipped definition, or,
  for your own shortcuts, from what you last saved.
- Deleting a shipped shortcut. It leaves the list and the address bar, and
  your edits to it are kept, so **Reset to defaults**, **Start over** or
  importing an older export with **Replace everything** brings back the
  shortcut you had. There is no per-shortcut restore. Switching a shortcut
  off, rather than deleting it, is the reversible one.
- Sections. Any shortcut can go in any section, shipped sections can be
  renamed, and you can create and delete your own from Settings or from the
  form's section menu. Deleting a section moves its members to My shortcuts
  rather than deleting them.
- Collapsible groups in the shortcut list, with Collapse all and Expand all.
  Each profile remembers its own state, and filtering expands the groups
  until you clear the filter. Switched-off shortcuts are not listed in their
  section: they are all in one **Hidden shortcuts** group at the foot of the
  page, folded by default, and switching one back on returns it to its
  section. In that group they are gathered under the section they came from,
  and each of those runs has one button that switches all of it back on:
  **Turn on all of Developer** when none of the section is on, **Turn on the
  rest of Developer** when part of it already is. **Turn them all on** empties
  the group when more than one section is in it.
- Export format 2, which carries edits, deletions and sections. Files written
  by the previous format still import.
- `pnpm package`: a deterministic, zero-dependency release zip with
  `manifest.json` at its root and no sourcemaps.
- GitHub Actions CI running typecheck, tests, build and the release packer,
  plus an icon-drift check. Also the MIT License, and CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT and PRIVACY files.

### Changed

- A complete visual refresh onto one token set (`design/tokens.css`), shared
  by the options page, the popup and the extension icon: flat surfaces, a
  single warm-sand accent, and system light and dark with no toggle. Inter
  now ships with the extension as a bundled font file rather than being
  requested from the network.
- Per-shortcut key rebinding (`keyOverrides`) is folded into the new edit
  layer, so you edit keys in the same form as everything else. Existing
  stored state and exports are migrated on read.
- The `media` category is gone. A shortcut's category is now an open section
  id rather than a closed union.
- Shipped shortcuts are now grouped into packs that the first run asks about,
  so a fresh install has only Search, Developer and AI switched on. Google,
  Microsoft, Social, Productivity and Purdue are all opt-in. The Brightspace
  and Gradescope handlers now read their host off the shortcut's own URL too,
  so rebinding one to another institution works.
- **Confirm before opening a shortcut** now stops the dispatch page and waits.
  It names the keyword that fired and the shortcut it matched, prints the URL
  it is about to open, and offers an Open button, which holds the focus, and
  the escape search. The 1.2 second toast it replaces navigated on its own,
  which is a delay rather than a confirmation.
- The rule-status pill says **Shortcuts active** instead of counting
  keywords, and **Some keywords not intercepted** when coverage is partial.
  The count moved every time a shortcut was switched on or off, and nobody
  acted on it. The numbers that do matter, what you exempted and what Chrome
  refused, are still on the line under it and on the Settings coverage line.
- `web_accessible_resources` is narrowed to `go.html`. `go.js` and `assets/*`
  are same-origin subresources of an extension page and never needed an
  entry. Listing them exposed them, and the shipped sourcemaps, to the search
  engines.

### Removed
- The green *Shortcuts active* pill. The rule-status pill in the topbar now
  appears only when there is something to act on: partial coverage, a failed
  sync, or interception switched off. A healthy profile shows nothing.
- The `?` shortcut and the **Default AI** setting it read (`settings.defaultAi`).
  Pick the assistant with its own keyword instead: `c`, `gpt`, `gem` or `cc`.
- The **AI prompt templates** card. `settings.aiTemplates` still overrides a
  provider's prefill URL; it is edited in an exported JSON file and imported
  back with **Replace everything**.
- The separate inline keyword-rebind editor, replaced by the unified form.
- `extras/removed-commands.ts`, now `extras/packs/removed-commands.json`. It
  is an importable pack rather than uncompiled code in the repo.

### Fixed

- Concurrent rule syncs colliding on rule ids. A burst of saves, which is
  exactly what the onboarding write produces, could have two rebuilds read
  the same rule ids and both add them. Chrome refused the second, and the
  fail-closed path answered a refusal by tearing the whole dynamic rule table
  down, leaving no address-bar interception at all. Syncs are now serialized
  with one trailing coalesced slot.

## [1.0.0] - 2026-09-01

### Added

- First release: keyword shortcuts for the address bar via
  `declarativeNetRequest`, a shortcut manager (options page), a toolbar
  popup, and an omnibox keyword (`bl`).

[Unreleased]: https://github.com/ion05/bunnylol/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ion05/bunnylol/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ion05/bunnylol/releases/tag/v1.0.0
