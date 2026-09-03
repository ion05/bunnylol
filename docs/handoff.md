# Handoff: the v1.1.0 open-source release

For the next agent or person who picks this branch up. It is a map, not a spec. `AGENTS.md` is
still the authority on conventions and invariants, and it wins over anything written here.

This file may be deleted before the release branch merges. It describes work in flight.

## 1. What this is and where things are

BunnyLol is a Manifest V3 Chrome extension that turns the address bar into a command line. This
branch takes it from a personal tool to something publishable.

| Thing | Where |
|---|---|
| Repo | `github.com/ion05/bunnylol` |
| Branch | `ion05/open-source-redesign-bunnylol`, tracking `origin` |
| Pull request | https://github.com/ion05/bunnylol/pull/11, open against `master` |
| Agent context | `AGENTS.md` at the repo root. `CLAUDE.md` just points at it. |
| Human contributor guide | `CONTRIBUTING.md`, the same material for a person |
| User docs | `README.md` |
| Design system | `design/`, with `design/README.md` as its authority |

The planning material lives in `.context/` in this workspace. `.context/` is in `.gitignore`, so
it is workspace-local and never reaches the repo or the PR. If you are working from a fresh clone,
you will not have it. Read it here:

- `.context/attachments/2VKc9L/plan.md` is the master plan. Its decisions table and its "Calls
  made" list are binding.
- `.context/brief.md` is the shared brief every implementing agent read first.
- `.context/units/pr1.md` through `pr12.md` are one spec per commit layer.
- `.context/design-feedback.md` collects the gaps found in the owner's design bundle.
- `.context/pr-body-draft.md` is the text the PR body was written from.
- `.context/planner/*.md` are the original planner and audit dumps. Large. Grep them, do not read
  them end to end.

When `AGENTS.md` and `.context/` disagree, `AGENTS.md` wins. It is the file that ships.

## 2. The owner's binding decisions

These were confirmed with the owner. Do not reopen them without asking.

- **Look.** Raycast style: dense, keyboard first, compact rows, flat surfaces. One accent,
  `#e1ab76` sand. Inter bundled as a local woff2. Follow the system light and dark setting, with
  no toggle in the UI.
- **Design review.** Claude Design, not screenshots. Only the approved system got implemented.
- **Licence and name.** MIT. The name stays "BunnyLol". The README says it is unofficial and not
  affiliated with Meta.
- **Storage.** `chrome.storage.local` only.
- **Purdue.** Stays, as an opt-in pack that is off after the first-run pick. The Brightspace and
  Gradescope handlers read their host off the command's own URL, so rebinding one to another
  school works.
- **Tooling.** GitHub Actions only. No ESLint, no Prettier, **no new dependencies of any kind**,
  devDependencies included.
- **Chrome Web Store.** Code and packaging only. No screenshots and no listing copy in this repo.
- **Version.** 1.1.0 in `package.json` and `public/manifest.json`. Export format 2, with a reader
  for format 1.
- **Onboarding.** Packs only. On install: write the starter pick, then sync the rules, then open
  the welcome tab. Purdue is shown unticked. Meta shortcuts (`bl`, `add`, `set`) are always on and
  never listed. Continue performs exactly one write. Closing the tab keeps what is already live.
- **Unified shortcuts.** Every shortcut has Edit, on/off and Delete, shipped or not. One form.
  Reset refills the form from the shipped definition, or from the last save for a user shortcut.
  Deleted shipped shortcuts come back from Settings. `handler`, `provider` and `builtin` are never
  editable.
- **Collapse.** Expanded by default. Remembered in `localStorage`, never in settings. A live
  filter force-expands.
- **Sections.** Any shortcut into any section. Shipped sections can be renamed. Deleting a user
  section moves its members to My shortcuts.
- **Delivery.** One branch and one PR, not a stack. One architectural layer per commit. Every
  commit green on its own.

### The one deviation

The accent is two tokens. `#e1ab76` is 2.04:1 on white, so it cannot legally be text, a focus ring
or a state indicator in light mode. `--accent` is a fill only. `--accent-text` is the same hue and
saturation at half lightness and carries links, the keyword mark, the focus ring and the active nav
underline. In dark mode the raw sand is readable and does both. `tests/tokens.test.ts` forbids
`color: var(--accent)`.

### Smaller calls worth knowing

- The `media` category was removed. `normalizeCategory` coerces unknown ids to `custom`.
- `enabledCategories === null` is the only "never onboarded" signal.
- An existing user is never shown the picker unasked. Settings links to it.
- `edits` entries are for shipped ids only. User shortcuts are edited in place.
- Inter ships whole, with `unicode-range` limiting rasterisation. No subsetting tool was added.
- Numeric counts of commands and tests were removed from the docs, not refreshed. Keep them out.

## 3. What was built, layer by layer

Each line is one commit or one small group. The commit bodies explain why. Read them with
`git log --format='%h %s%n%b' 6493ef2..HEAD`.

| Layer | What landed | Key files |
|---|---|---|
| Repo hygiene | MIT licence, privacy, security and conduct files, changelog, CI, issue and PR templates, the removed-commands pack | `LICENSE`, `PRIVACY.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/`, `extras/packs/` |
| Lib hardening | `syncRules` serialized with one trailing coalesced slot; the Purdue handlers read their host off the command | `src/lib/dnr.ts`, `src/lib/handlers.ts`, `tests/sync-rules.test.ts` |
| Shared helpers | Verbatim lifts out of the UI surfaces | `src/lib/text.ts`, `src/lib/draft.ts`, `src/ui/dom.ts` |
| Design system | The approved bundle, committed as approved; both sheets moved onto the tokens; Inter bundled | `design/`, `src/options/options.css`, `src/popup/popup.css`, `public/fonts/`, `tests/tokens.test.ts` |
| Data model I | Stable ids, section validators, the edit and delete override layer, export format 2 | `src/lib/overrides.ts`, `src/lib/storage.ts`, `src/lib/validate.ts` |
| Data model II | Open sections, the pack algebra, import merge, the adversarial suite | `src/lib/onboarding.ts`, `src/lib/merge-import.ts`, `tests/overrides-security.test.ts` |
| Options split | The page monolith became router, store, models and views. A pure move. | `src/options/router.ts`, `store.ts`, `dom.ts`, `rule-status.ts`, `model/`, `views/` |
| Features | One edit form for every shortcut, restore, collapsible groups, the sections card, import copy | `src/options/views/form.ts`, `browse.ts`, `settings.ts`, `data.ts`, `src/options/model/collapse.ts` |
| Onboarding | The `#welcome` picker and the install-time starter pick | `src/options/views/welcome.ts`, `src/options/model/welcome.ts`, `src/lib/install.ts` |
| Restyle | Browse, topbar and status; then form, settings, data, welcome, popup and the dispatch page; then the icon painted from the tokens plus the store tile | `src/options/options.css`, `src/popup/popup.css`, `go.html`, `src/go/go.ts`, `scripts/gen-icons.mjs` |
| Release | Manifest narrowed to `go.html`, version 1.1.0, a deterministic zip, docs rewritten, invariants 15 to 17 recorded | `public/manifest.json`, `scripts/package.mjs`, `tests/manifest.test.ts`, `README.md`, `AGENTS.md` |

### Added after the PR opened

- The welcome picker's pack cards unfold to list the shortcuts a tick turns on.
- Row actions are icons in the order Edit, Delete, then the on/off switch.
- The "Turned on N packs" notice and the "Intercepting N keywords" status headline were removed.
- `track <number>`, also `pkg`, reads the carrier off the shape of the number and opens that
  carrier's own page. A `dhl` shortcut joins `ups`, `fedex` and `usps`.
- A writing pass: every doc and every string a user reads was simplified, and every em dash
  removed. No tracked file outside `design/` has one now.
- The welcome screen intro was rewritten and its explainer paragraphs trimmed.
- **Start over** in Settings, under Data. It deletes the state key and reruns the install path, so
  the welcome flow can be tested again in a used profile.
- Group counts and the toolbar count now say how many of the rows they cover are on.

## 4. How the work was run, and the rules to keep

### The loop

1. One subagent implemented one unit, from its spec in `.context/units/`. Opus for code, Sonnet
   for mechanical moves and docs.
2. Three adversarial reviewers then read it: one for spec completeness, one for correctness and
   the `AGENTS.md` invariants, one for conventions. The correctness reviewer used mutation
   testing: break the code the test guards, confirm the test goes red, put it back. A test that
   stays green either way is not a test.
3. A fix round folded the findings back into the same commit. Nothing was left for later.
4. The commit was then checked out on its own and put through the gate.

### The gate

```bash
pnpm typecheck && pnpm test && pnpm build
```

All three, green, on **every** commit, not just at the tip. That is a project convention, and it
is checkable: `git checkout <sha>` and run it.

CI runs the same three steps, plus two more:

- `git diff --exit-code -- public/icons store`, because `pnpm build` repaints the icons from
  `design/tokens.css` and the PNGs are committed. Changing the generator or the accent without
  committing the result shows up as a dirty tree.
- `node scripts/package.mjs`, because the packer has no test and writes a binary nothing else
  reads. Running it over a real build is the cheap guard.

### Rules any new agent must keep

- Run the gate before you commit, and again after any fix.
- Stage by explicit path. Never `git add -A`. The tree often holds another agent's work.
- Commit subjects are imperative, at most 72 characters, with no trailing period. The body says
  what changed and why.
- No new dependencies, devDependencies included.
- No em dashes in any project-owned text.
- CSS uses `design/tokens.css` custom properties and the class vocabulary in
  `design/components.css`. No literal hex, no raw `font-size: Npx`, and never
  `color: var(--accent)`. `tests/tokens.test.ts` enforces all of it.
- `src/lib` and `src/options/model` must import cleanly under vitest's `environment: node`. No
  `document` and no `chrome.*` at module scope.
- Comment only where the reason is non-obvious. Carry existing comments across moves verbatim.
- User text reaches the DOM only through `textContent` or `createElement`.
- Do not "fix" a failing test from the invariants list. Fix the code.

## 5. State of play

### Done

Everything in the table in section 3, plus everything under "Added after the PR opened". The
branch is pushed and the PR is open. The tree was clean at the time of writing.

### Owed by the owner

No browser was available in the build sessions, so nothing below could be done by an agent.

1. Load `dist/` unpacked and screenshot `options.html#help` in light and dark for the PR body.
2. Fresh profile: `#welcome` opens with Search, Developer and AI ticked and everything else
   unticked. Close the tab. `bs cs251` should search normally and `gh facebook/react` should land
   on the repo. Rule status green.
3. Edit `gh`, rename it and change its URL, and check the `modified` badge. Reset, Save, badge
   gone. Delete `gh`, then restore it from Settings. Delete `bl` and restore it.
4. Create a section from the form, move `gh` into it, rename a shipped section, delete the new
   one and confirm its member returns to My shortcuts. "Restore default name" should refuse when
   another section already carries that label.
5. Collapse two groups and reload. Still collapsed. Type in the filter, they expand. Clear it,
   they collapse again. Collapse all and Expand all.
6. Export, then import with Merge, and check the dialog names edits, deletes and sections by
   label. A format 1 export file with a `media` shortcut in it must still import.
7. Popup: `gh f` highlights the keyword and Enter navigates. The selected row is sunken. The
   toolbar icon is legible on light and dark toolbars.
8. One real intercepted search from Google, Bing and DuckDuckGo, to check the narrowed
   web-accessible resources. A missing resource fails silently. Then the dispatch toast and the
   error page.
9. `pnpm package`, then `unzip -l release/bunnylol-1.1.0.zip`: `manifest.json` at the root and no
   `.map` files. Drag the zip into the Web Store dashboard once, to confirm the hand-rolled zip is
   accepted.
10. Compare `options.html` at `#help`, `#new` and `#settings`, plus `#welcome`, the popup and
    `go.html`, against `design/canvas/*.dc.html` in both schemes.
11. Web Store screenshots. At least one 1280x800 PNG is a hard submission blocker, and this repo
    deliberately does not produce them. See `docs/chrome-web-store.md` under "Assets".
12. The contract gaps in `.context/design-feedback.md`. They are edits to `design/`, which is the
    approved bundle and was implemented as approved. They need a design review, not a passing fix.

### Open decisions

- **The bare `track` landing page.** With no number to read, `track` goes to `parcelsapp.com`,
  a third party. It is the one page that accepts every carrier's number. Nobody has confirmed
  that a third-party landing page is acceptable.
- **`track` and `pkg` as keywords.** Both are ordinary English first words. The first word always
  wins, so both will hijack some real searches. The escape prefixes are the answer, but the owner
  may still want to rename or drop one.
- **The omnibox middle dot.** The em dash separator became `·` to match the dispatch toast and the
  status line. A comma would have read as part of the shortcut's name. Nobody has seen it in a
  real omnibox yet.
- **Whether this file stays.** It documents work in flight. It is probably deleted before the
  merge.

### A bug report that could not be reproduced

Someone reported that Continue on the welcome screen turns on all packs. It was investigated end
to end and does not reproduce: `applyCategoryPick` projects the pick into `Overrides.disabled` and
switches the unticked packs off. The likely cause is what the Shortcuts page then showed. It
listed every pack at full strength, with the off rows only dimmed, so a correct pick read as a pick
that had done nothing. The count fix in the last commit is the answer to that. If the report comes
back, check `applyCategoryPick` in `src/lib/onboarding.ts` and the counts in
`src/options/model/browse.ts` before anything else.

## 6. Known non-obvious facts that bit us

These are the things reviewers caught. Each looks like reasonable code.

- **The meta shortcuts ship a relative URL.** `bl`, `add` and `set` point at `options.html#…`, and
  the dispatch page absolutises it. Applying `withScheme` unconditionally on save turned a
  no-change Save into a stored `https://options.html#help` that opened nothing, permanently. See
  `keptUrl` in `src/lib/draft.ts`.
- **The live preview substitutes a shipped command at its own registry index.** `buildKeyMap` is
  first-writer-wins, so appending the draft instead would preview a different resolution than the
  save produces. See `previewCommands` in `src/options/model/form.ts`.
- **Format 1 exports can carry a `media` category.** Refusing them made every such file
  unimportable, with hand-editing JSON as the only fix. An unknown category on a user shortcut
  falls back to My shortcuts. An unknown category on an edit is dropped instead, because a shipped
  command has its own. The two are deliberately not symmetric. See invariant 17.
- **A re-minted custom id has to be rewritten in `disabled` and `deleted` too.** Otherwise the
  entries follow the wrong shortcut and the newcomer inherits the incumbent's history. See
  `landedAs` in `src/lib/merge-import.ts`.
- **`.panel-head-text` does not exist in the design bundle.** The product's panel heads carry a
  "Saved" announcement beside the title and no artboard shows it. It is gap 4 in
  `.context/design-feedback.md`.
- **`?raw` CSS imports need `css: true` in `vitest.config.ts`.** Vitest stubs anything matching
  `*.css` to an empty module, and that stub beats the raw loader. Without the flag the sheets
  arrive as empty strings and every token assertion passes vacuously.
- **`light-dark()` needs Chrome 123.** That is why `public/manifest.json` sets
  `minimum_chrome_version` to `123`, and `tests/tokens.test.ts` pins it.
- **`--accent` and `--accent-fg` must stay flat hexes.** `scripts/gen-icons.mjs` parses those exact
  declarations to colour the icon. Wrapping either in `light-dark()` throws the build.
- **`.spec-row` is a harness class.** It belongs to `design/preview.css` and appears in the
  artboards. The product renders `.row`. A harness class must never reach the shipped sheet.
- **`hasOnboarded` is true on every real install** by the time the welcome tab opens, because the
  starter pick is written first. So the closing line is keyed on the pick that is actually live,
  not on whether the picker has been answered. They come apart for a format 1 profile arriving from
  Settings, or an install whose write failed. See `closingLine` in `src/options/model/welcome.ts`.

## 7. How to run things

```bash
pnpm install                 # pnpm only. npm install creates a second lockfile.
pnpm typecheck && pnpm test && pnpm build   # the gate
pnpm package                 # build, then release/bunnylol-<version>.zip
node scripts/gen-icons.mjs   # repaint the icons from design/tokens.css
```

`pnpm build` writes `dist/`. Load that folder unpacked at `chrome://extensions` with Developer
mode on. Other Chromium browsers work the same way.

**Reload, do not remove and re-add.** Editing source does not update a loaded extension, so click
reload on the card after every build. Removing the extension and adding it back is a different
thing: it usually takes the profile's storage with it, and the install path then rewrites the
starter pick and opens the welcome tab. If the storage does survive, `writeStarterPick` is guarded
by `hasOnboarded` and does nothing. Either way, use **Settings, Data, Start over** when you want to
see the first run again on purpose. It deletes the state key and reruns the install path.

The design previews are plain HTML files. Open them in a browser straight from disk:

```
design/foundations/   colours, type, space and radius
design/components/    buttons, inputs, status, messages
design/patterns/      topbar-nav, browse, edit-form, settings-sections, welcome, popup, dispatch
design/canvas/        the approved artboards, *.dc.html
```

One caveat. `design/preview.css` loads the font as `../fonts/InterVariable.woff2`, which resolves
relative to the stylesheet and so points outside `design/`. The standalone previews therefore fall
back to the system font. The fix is gap 1 in `.context/design-feedback.md`. It affects the review
harness only. The shipped pages load Inter from `public/fonts/`.

## 8. Where to look next

| If you want to | Start here |
|---|---|
| Change the palette, type scale or spacing | `design/tokens.css`, then `pnpm build` to repaint the icons and commit the PNGs. `tests/tokens.test.ts` is the guard. |
| Restyle a surface | The contract in `design/components.css` and the matching file in `design/patterns/`. Then `src/options/options.css` or `src/popup/popup.css`. |
| Add or change a shortcut | `src/lib/commands.ts`, plus the registry rules in `AGENTS.md` under "Editing the command registry". Aliases are globally unique and every handler must be used. |
| Add a smart argument handler | `src/lib/handlers.ts`, and the `HandlerId` union in `src/lib/types.ts`. Guard the input shape and degrade to a search (invariant 7). |
| Change onboarding | `src/lib/onboarding.ts` for what a pick means, `src/lib/install.ts` for the install path, `src/options/model/welcome.ts` for what the page says, `src/options/views/welcome.ts` for the DOM. |
| Change the import or export format | The `normalize*` and `parse*` pairs in `src/lib/storage.ts`, then `src/lib/merge-import.ts`. Every new field needs both halves of the pair. |
| Change validation | `src/lib/validate.ts`, and only there. Add a call site rather than a local rule (invariant 6). |
| Touch address-bar interception | `src/lib/dnr.ts` and `src/lib/resolve.ts`. Read invariants 1 to 5 and 15 first, and replay real Chrome URLs through `tests/helpers/rules.ts`. |
| Change the browse list, filter or folds | `src/options/model/browse.ts` and `model/collapse.ts` for the decisions, `views/browse.ts` for the DOM. `applyFilter` is the only writer of row and rows `hidden`, and of both counts. |
| Change the edit form | `src/lib/draft.ts` for parsing, `src/options/model/form.ts` for validation and the preview, `src/options/views/form.ts` for the DOM. |
| Change what a section is | `src/lib/overrides.ts`. Read invariant 17: every lookup keyed by a category is hostile input. |
| Change the packaging or the manifest | `public/manifest.json`, `scripts/package.mjs`, `tests/manifest.test.ts`. Bump both versions in one commit. |
| Submit to the Web Store | `docs/chrome-web-store.md`. It has the permission justifications, the privacy answers and the upload checklist. |
| Add a shortcut pack | `extras/packs/`. Data, not code, and outside tsconfig on purpose. `extras/packs/README.md` documents the format. |
