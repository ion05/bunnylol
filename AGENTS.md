# AGENTS.md

Context for AI coding agents working in this repo. Read this before changing anything.

`README.md` documents the extension for someone *using* it. This file is for someone *changing* it.

## What this is

A Chrome Manifest V3 extension that turns the address bar into a command line, in the style of the
bunnylol command bar used inside Meta. Type `gh facebook/react` and land on the repo, not on a
search results page. It is not affiliated with Meta, and the README, any listing copy AND the extension's own UI have
to say so. The welcome screen is the one place a user or a store reviewer meets the claim at
runtime, so the disclaimer lives next to it in `src/options/views/welcome.ts` rather than only in
the documentation.

The shipped shortcuts are plain data in `src/lib/commands.ts`, grouped into packs the user picks
from on first run. Everything a user then does to one (rename, re-key, move, switch off, delete) is
an override layer on top. The registry is never mutated, so a corrected URL in a later build still
reaches someone who only renamed the command.

## The one decision that explains everything

**The first word of an address-bar query is ALWAYS a command when it matches a registered
keyword.** `c programming tutorial` goes to Claude. `pr firms in new york` goes to the user's
GitHub pull requests. This is deliberate. It is how Meta's bunnylol works, and it was chosen
explicitly over three alternatives (an opt-in allowlist, a sigil prefix, and a curated blocklist)
after the blocklist approach failed to converge: a verifier found that roughly two in five of the
eligible aliases could hijack some plausible English search, and blocking those only surfaces the
next tier.

The escape hatch is therefore load-bearing, not a nicety. A leading `\` or `=`
(`FORCE_SEARCH_PREFIXES` in `types.ts`) forces a plain search. If you weaken the escape path, you
break the entire product.

`Settings.interceptStopList` exists as a user-curated *exemption* list and **defaults to empty**
(`DEFAULT_STOP_LIST`). Do not repopulate it as a blocklist. That was tried and rejected.

## Architecture

```
src/lib/types.ts        The frozen contract. Everything imports it. No chrome.*, no DOM.
src/lib/commands.ts     The shipped registry + SEARCH_ENGINES
src/lib/handlers.ts     Smart argument handlers + AI_PROVIDERS
src/lib/resolve.ts      resolve(query, commands, settings) -> ResolveResult. Pure. The brain.
src/lib/validate.ts     The single validation boundary: aliases, URLs, section ids and labels
src/lib/overrides.ts    Shortcut identity (`shortcutId`, `u:` ids) + the edit/delete/section algebra
src/lib/onboarding.ts   What a pack pick means: `applyCategoryPick`, `migrateNewBuiltins`
src/lib/merge-import.ts Folding an import onto the state already here (`mergeOverrides`)
src/lib/storage.ts      chrome.storage.local persistence, export, and the entry point below
src/lib/storage/normalize.ts     LENIENT reader: any blob in, a usable state out. Never throws.
src/lib/storage/parse-import.ts  STRICT import parser + the v1 file reader. Refuses by name.
src/lib/storage/shared.ts        What both need: guards, the shipped ids, custom-id assignment.
src/lib/dnr.ts          `syncRules`: the serialized rebuild + the remembered RuleStatus
src/lib/dnr/rules.ts    Every registrable rule. `buildRules` and `syncRules` share it.
src/lib/dnr/keywords.ts Which aliases survive the caps, and the two orders they live in
src/lib/dnr/fit.ts      Chrome's RE2 check, resplitting a refused shard, coverage wording
src/lib/draft.ts        What the edit form edits, and the pure parsing around it
src/lib/text.ts         String helpers every surface shares
src/lib/url.ts          Small URL helpers
src/lib/install.ts      The onInstalled branch: starter pick, rule sync, welcome tab
src/background.ts       MV3 service worker: listener registration, rule sync, omnibox
src/go/go.ts            Dispatch page: resolves and navigates
src/ui/dom.ts           `el` / `mark` / `nextId`: the element builders every surface shares
src/options/            Shortcut manager UI (below)
src/popup/              Toolbar command bar
design/                 The approved design system. `tokens.css` is shipped; the rest is review.
scripts/                gen-icons.mjs, package.mjs, and `scripts/lib/` (pure, importable helpers)
store/                  Web Store listing assets. Outside `public/`, so never packed into dist/.
docs/                   fonts.md (the bundled Inter), chrome-web-store.md (the submission crib)
extras/packs/           Importable JSON packs. Data, not code; not compiled.
```

The options page is a set of modules with one job each, not a page object:

```
src/options/options.ts      Boot, the storage-echo guard, render dispatch
src/options/router.ts       Hash routing: `startRouter(onChange, render)`, `go`
src/options/store.ts        Page state behind accessors; `commitOverrides`/`commitSettings`/
                            `commitState` are the only writers. `setAfterCommit` and
                            `setStatusPainter` are installed BEFORE the first render, because
                            that render can already commit or navigate.
src/options/dom.ts          Stateless widgets the views assemble panels from
src/options/rule-status.ts  The pill in the topbar and the coverage line in Settings
src/options/status.ts       Pure: a `RuleStatus` in, the words and the tone out
src/options/model/*.ts      browse, collapse, form, welcome: the decisions, without a DOM
src/options/views/*.ts      form, settings, data, welcome, packs: the DOM
src/options/views/browse.ts        The Shortcuts route: panel assembly, and `applyFilter`
src/options/views/browse-groups.ts The group headings, the runs, and refiling a row between
                                   them. Writes nothing that is on screen.
src/options/views/browse-row.ts    One row: the chips, the destination, Edit/Delete/switch
```

The browse route is three files split along one line. `applyFilter` in `views/browse.ts` is the only
writer of `row.hidden`, `rowsHost.hidden`, every count and the "omnibox only" badge, so the other two
build and refile and write none of them: the headings and the bulk-action buttons are built EMPTY,
and every function that changes what a group holds takes the repaint as a callback instead of doing
it. That makes the rule a grep over two short modules rather than a reading of one 380-line closure,
which is where two shipped bugs lived. `browse-groups.ts` is plain functions over their arguments,
not a factory closed over the page state: a factory would have to be built before `applyFilter` and
then be read by it, putting a mutable slot on the very seam the rule lives on.

`views/welcome.ts` and `views/packs.ts` are two screens over one question. `#welcome` is the tab the
install opens, so it introduces the product and offers Skip; `#packs` is reached on purpose from
Settings, so it says what saving does and offers Save and Cancel. The cards, the ticks and the one
write live in `packs.ts` and `model/welcome.ts`, shared verbatim, so a pack added to the registry
cannot reach one screen and not the other. `#packs` is deliberately not an alias of `#welcome`: only
one of them may introduce a product the user is already using.

`install.ts` is separate from `background.ts` because the service worker registers listeners
synchronously at module scope. `chrome.omnibox.setDefaultSuggestion` runs the moment that file is
loaded, which makes it unimportable in a test. The listener there hands the event straight to
`onInstalled`, so the install path is driven end to end against the storage and rule stubs.

A shortcut's `category` is an OPEN section id: a shipped `Category`, or the id of a `Section` in
`Overrides.sections`. `sectionLabel` resolves it for display. `CATEGORIES` stays the closed shipped
list, and the registry rows are typed `BuiltinCommand`, so a typo'd shipped category is still a
compile error.

The onboarding pick is not a second exclusion axis. `Overrides.enabledCategories` records what the
user chose, so the picker can be reopened with their answer. `applyCategoryPick` projects the
*effect* onto `Overrides.disabled` at write time. The resolver reads `disabled` and nothing else,
so DNR, the omnibox and the popup inherit a pick for free, and none of them has to know what a
category is.

`resolve.ts` is pure and shared by every surface: dispatch page, omnibox, popup, options live
preview, tests. Behaviour cannot drift between surfaces because there is one code path. Keep it
that way: no `chrome.*` and no DOM in `resolve.ts`.

Handlers (`HandlerId` in types.ts): github, githubPulls, githubIssues, githubGist, reddit, npm,
gmail, gdrive, gcal, googleApp, outlook, onedrive, teams, ai, brightspace, gradescope, youtube,
meta, zoom, meet, tracking, track, instagram, whatsapp, word.

## Invariants that were violated during development

Every one of these was a real shipped bug caught by adversarial verification. They have regression
tests. **If a test in this list fails, do not "fix" the test.**

1. **BunnyLol must never intercept its own output.** Some commands resolve to a URL on a search
   engine we intercept (`g`, `ddg`, and historically `weather`). `destination()` in `resolve.ts`
   marks these with the passthrough param, so the higher-priority allow rules claim them. Without
   it, `weather` looped infinitely and `g npm install` landed on npmjs.com.
   Guarded by `tests/self-interception.test.ts`, which derives the at-risk set **from the rules**
   (every command whose resolved URL a redirect rule would actually claim back) rather than naming
   commands. So it cannot silently become vacuous when a command is removed.

2. **DNR rule priority is `redirect (1) < escape (2) < allow (3)`,** and `fitPlan` fails closed:
   an engine gets redirect rules only if Chrome accepted both its allow and escape rules.
   Registering redirects without them leaves the user in a redirect loop with no escape.

3. **A failed sync must not leave stale rules live.** `updateDynamicRules` is atomic, so a throw
   leaves the *previous* rules running. `syncRules` retries remove-only, and if that also fails it
   reports the coverage genuinely still live rather than claiming zero.

4. **The DNR regex must consume the whole URL remainder,** not just the terminator. Chrome appends
   `&sourceid=chrome&ie=UTF-8` (Bing: `&PC=U316&FORM=CHROMN`, DDG: `&t=hc`) to address-bar
   searches. RE2 has no lookahead, so the pattern swallows the tail and the substitution drops it.

5. **Keyword retention is ranked separately from alternation ordering.** The alternation must be
   longest-first so `github` beats `gh`. But truncating *that* order removes exactly the short hot
   aliases: at ~400 custom shortcuts, `gh`, `g` and `npm` silently stopped being intercepted.

6. **All alias, URL and section validation goes through `src/lib/validate.ts`.** Nothing re-derives
   a rule locally. Today's callers are the import parser (`storage/parse-import.ts`), the override algebra
   (`overrides.ts`), the one shortcut form (through `draft.ts` and `model/form.ts`), the section
   editor and the "Exempt keywords" field in Settings, and `resolve.ts` for `isInterceptableAlias`.
   That list will grow, so add a call site rather than a local rule. When the rule lived in
   whichever module needed it, each had a different hole: whitespace aliases and scheme-less URLs
   both persisted happily while being unusable. `validateAlias` also rejects an alias starting with
   an escape prefix, since `resolve()` strips that before the key map is ever consulted.

7. **Free text never goes into a slot expecting a specific shape.** Tracking numbers, Zoom meeting
   ids, phone numbers and dictionary headwords all guard their input and degrade to a search.
   Otherwise `fedex near me open now` renders "tracking number not found".

8. **Arguments are never silently dropped**, with one deliberate, enumerated exception. The cloud
   consoles (`aws`, `gcp`, `vercel`, `netlify`, `cf`) had their `site:` doc search removed on
   request and are pure jumps now. They are listed by name in `tests/commands.test.ts`, so adding a
   third is a decision someone makes, not a test that quietly stopped caring.

9. **No command may have a write side effect as its default argument behaviour.** `td bank near me`
   used to open Todoist's quick-add *prefilled*. Quick-add lives on a separate `tda` alias.

10. **`buildKeyMap` is first-writer-wins** and `mergeCommands` puts custom commands first, so a
    user's own `gh` shadows the builtin rather than being ignored.

11. **User text reaches the DOM only via `textContent`/`createElement`.** A shortcut name is
    untrusted input. `background.ts` XML-escapes omnibox descriptions or Chrome silently drops the
    suggestion.

12. **`resolve()` never throws.** A handler that blows up degrades to the command's bare
    destination.

13. **`RuleStatus` separates a fatal `error` from a partial-coverage `warning`.** They used to be
    one field, which made the options page render the red "Rules not registered" state for a single
    dropped keyword and left the amber state unreachable.

14. **Vite's `crossorigin` and modulepreload tags are stripped** in `vite.config.ts`. On a
    `chrome-extension://` page the browser treats `crossorigin` as a cross-world mismatch and
    discards the preload, so the attribute costs the very thing it was meant to enable.

15. **`syncRules` is serialized, with one trailing coalesced slot.** Rule ids are renumbered
    densely from the current keyword count, so two overlapping rebuilds read the same `existing`
    ids and both add them. Chrome refuses the second, and `failClosed` answers a refusal by tearing
    the whole dynamic table down, leaving no address-bar interception at all. A burst of saves, one
    `onStateChanged` per onboarding write, is exactly that pattern. The fast path consults the
    trailing slot **before** the in-flight slot, because `chain` is cleared a microtask or two
    before the follow-up it scheduled starts, and a caller landing in that gap would otherwise open
    a third rebuild alongside it. Guarded by `tests/sync-rules.test.ts` `describe('concurrent
    syncs')`, which can only see the collision because `StubOptions.strictIds` reproduces Chrome's
    duplicate-id refusal: the unserialized path ends a burst with an empty rule table, and the naive
    chain-only ordering fails somewhere inside that gap. The sweep walks every arrival tick up to a
    bound derived from `ticksToSettle()` rather than a written-down number, so a rebuild that grows
    longer cannot push the window past the end of the sweep.

16. **An edit may never change a shortcut's identity or behaviour selector.**
    `Overrides.edits` carries only the seven fields the edit form shows. `applyEdit` copies them
    one at a time rather than spreading, so a hand-edited import cannot set `handler`, `provider`,
    `builtin` or `id`. That is the difference between renaming GitHub and pointing the `github`
    handler at your own host. An edit whose `url` is blank or unparseable inherits the shipped one,
    because `rawDestination` returns `cmd.url` and an empty string is not a destination (invariant
    12). Guarded by `tests/overrides.test.ts`, by `tests/overrides-security.test.ts` (which drives
    the hostile shapes one field at a time) and by the whole-path test in `tests/storage.test.ts`
    `describe('an edit cannot smuggle behaviour through the import')`, which drives the JSON
    through `importJson` → `applyImport` → `mergeCommands` rather than calling `applyEdit`
    directly. Its last case hands `mergeCommands` an override object the parser never saw: the
    storage boundary strips these fields too, so without it the whole block stays green even if
    `applyEdit` went back to spreading.

17. **A category is an open section id, and every lookup keyed by one is hostile input.**
    `validateSectionId` is deliberately permissive. It accepts a builtin id, because that is how a
    shipped group gets renamed, and it accepts `constructor`. So `CATEGORY_LABELS[id]` on a
    user-supplied id answers with something off `Object.prototype`. Go through `sectionLabel`, or
    guard with `Object.hasOwn`. Two more rules follow from the same openness, and they are NOT
    symmetric. An unknown id on a **custom** command falls back to `FALLBACK_SECTION`, because it
    has nowhere else to go. An unknown id on an **edit** is dropped, because a shipped command has
    its own category, and relocating it to "My shortcuts" because a section vanished would move a
    shortcut the user never touched. The import parser degrades the same two ways rather than
    refusing the file. Refusing was tried, and it made every v1.0.0 export whose custom shortcut
    was filed under the since-removed `media` category unimportable, with the only fix being to
    hand-edit JSON the user did not write. The one category refusal left is structural: a
    `category` that is not a string names no id to degrade to. A pack SHOULD still declare the
    sections it files things under (`extras/packs/removed-commands.json` is the worked example); it
    just is not made to. Guarded by `tests/overrides.test.ts`, `tests/storage.test.ts` and
    `tests/overrides-security.test.ts`.

## Smaller rules, easy to undo by accident

These are not invariants, since no bug shipped from them. But each is a decision with a reason, and
the obvious edit reverses it.

- **`applyFilter` in `views/browse.ts` is the only writer of `row.hidden`, `rowsHost.hidden`, every
  count on the page and the "omnibox only" badge.** Collapse hides a group by writing the rows host. The filter hides
  individual rows and force-shows a collapsed group that matches. Two writers means a row that a
  cleared filter never brings back. The on/off switch is the one control that changes what is on
  screen without a re-render, and it still does not write any of those: it moves the row's node
  between its section and "Hidden shortcuts" and then calls `applyFilter`, which decides visibility
  and recomputes both headings. Which group a row is in IS its on-off state now, so nothing reads a
  class back off a row to count what is live.
- **A switched-off shortcut is drawn under "Hidden shortcuts", not in its section.** The fold id is
  `HIDDEN_GROUP_ID`, `@hidden` in `model/browse.ts`, and the `@` is load-bearing: the fold shares one
  `localStorage` set with the real sections, and `validateSectionId` mints ids matching
  `^[a-z0-9][a-z0-9-]*$`, so no label a user can type collides with it. A collision would let a
  section called "Hidden" inherit this group's fold, or fold this group by being renamed. A
  hand-edited import cannot mint one either: `normalizeCategory` files a category no section answers
  to under `FALLBACK_SECTION`. `browseGroups` still files a switched-off row under its own section,
  because switching it back on has to return it there without a re-render.
- **The runs inside "Hidden shortcuts" are a visual grouping, not groups.** The switched-off rows
  are drawn under a small heading per section, and a run of more than one offers the single action
  that switches all of it back on. A run owns no fold: it registers no id with `collapse()`, so
  nothing of it can collide with the section fold ids sharing that `localStorage` set. Its heading
  is a flex item ordered into the hidden group's one rows host rather than a box around its rows,
  which is what lets a row switched off later land back under the right heading without a new
  parent, and what keeps every row in the group in ONE list, which is what keeps `applyFilter` the
  only thing that counts. `applyFilter` writes the headings and the wording too, for the same
  reason it writes the counts: it is the one function that runs after every change.
- **A run's action says which of the two things it is doing.** `hiddenActions` in `model/browse.ts`
  answers with "Turn on all of Developer" when none of that section is live and "Turn on the rest of
  Developer" when some of it is. A button reading "Turn on Developer" would be claiming to switch on
  a section half of which is already on, and a section is usually only partly switched off. No label
  carries a count, because every number on that page comes from `applyFilter` and one baked into a
  label is the one figure that goes stale when a row moves. There is no confirm step: the action
  reveals the switches that undo it.
- **A bulk switch-on is exactly ONE write.** `enableAll` builds the whole next `disabled` list and
  `turnOn` commits it once. Calling the per-row switch handler in a loop instead would be a burst of
  saves, one `onStateChanged` each, which is the pattern invariant 15 exists to survive. Same rule,
  same reason, as the picker below.
- **Collapse state lives in `localStorage` (`bunnylol.collapsed`), never in `Settings`.** It is
  per-machine view state that changes several times a minute. In the state blob every fold would be
  a storage write, and every write re-syncs the DNR rules.
- **The stored fold set means "ids whose fold differs from the default", not "folded ids".** Every
  section defaults to open, so for those the two readings agree, which is what keeps a set written by
  an older build readable. They come apart for "Hidden shortcuts", which defaults to folded: a set
  that could only say "folded" has no way to record that the user opened it, so the group springs
  shut on every load. `createCollapseState(store, defaultCollapsed)` therefore stores departures, and
  `expandAll` clears the set back to the defaults rather than emptying it.
- **The picker performs exactly one write.** Continue on `#welcome` and Save on `#packs` both call
  the shared `savePick`, which calls `commitState` once with the whole pick. A write per ticked box
  is a burst of `onStateChanged` events, which is the pattern invariant 15 exists for.
- **`DEFAULT_OVERRIDES` is everything-enabled.** The Purdue pack is not off by default in the
  defaults. The install-time pick is what turns it off (`writeStarterPick` → `applyCategoryPick`).
  A profile that never onboarded therefore fails open with every shortcut live, which is what
  `migrateNewBuiltins` relies on when `enabledCategories` is null.
- **The install-time pick is written BEFORE `syncRules`.** That is what makes closing the welcome
  tab a real answer: the starter set is already live rather than waiting on a click. `syncRules()`
  is `.catch`-guarded there because it reads `chrome.runtime.id` before its own try, and a
  rejection in a fire-and-forget listener would skip the picker.
- **The picker opens only for a profile that never answered it.** `reason === 'install'` also fires
  when the extension is removed and added back over storage that survived. Resetting a configured
  profile to the starter set is the one thing that path must never do. Settings → "Choose shortcut
  packs…" is the way back in.
- **`edits` entries are for shipped ids only.** A `u:`-prefixed id names a user-created shortcut,
  which is edited in place. `normalizeEdits` drops an edit keyed by one.
- **There is no per-shortcut restore, and `deleted` still keeps the shortcut's edit.** The Settings
  card that offered one is gone, so the ways back are Reset to defaults, Start over, and importing a
  file that predates the delete with Replace everything. Merge cannot undelete: `mergeOverrides`
  unions the two `deleted` lists. Keeping the `edits` entry for a deleted id is what makes all three
  return the shortcut the user had rather than the shipped one, and it is why the import parser
  prunes `deleted` to ids this build ships instead of letting ghosts accumulate.
- **The dispatch confirmation runs no timer.** `settings.dispatchToast` holds `go.ts` on
  `confirmOpen` until the user answers: an Open button that takes focus, so Enter proceeds, and the
  escape search, whose own navigation is the outcome (the promise deliberately never resolves down
  that path, because a second navigation would race it). A confirmation the page navigates away from
  on its own is a delay, not a confirmation. `tests/go-dispatch.test.ts` reads the source and fails
  if a timer or the old toast node comes back.
- **`Settings.defaultAi` is gone; `settings.aiTemplates` survives with no UI.** The `?` command that
  read the default was deleted outright rather than parked in the removed-commands pack, because a
  keyword whose whole job was to read a setting that no longer exists has nothing to come back to. A
  command that names neither a provider nor a known alias now degrades to the first entry of
  `AI_PROVIDERS`. `aiTemplates` still overrides a provider's prefill template and is still validated
  by the import parser; it is edited through an exported JSON file. Do not delete the plumbing
  because no card writes it, and do not reintroduce a settings field the resolver would have to read
  to answer a keyword.
- **Meta shortcuts ship a RELATIVE url.** `bl`, `add` and `set` point at `options.html#…` and the
  dispatch page absolutises it. Applying `withScheme` unconditionally on save turned a no-change
  Save into a stored `https://options.html#help` that opened nothing, permanently. See `keptUrl` in
  `src/lib/draft.ts`.
- **The live preview substitutes a shipped command at its own registry index.** `buildKeyMap` is
  first-writer-wins, so appending the draft instead would preview a resolution the save does not
  produce. See `previewCommands` in `src/options/model/form.ts`.
- **A re-minted custom id has to be rewritten in `disabled` and `deleted` too.** Otherwise those
  entries follow the wrong shortcut and a newly imported command inherits the incumbent's history.
  See `landedAs` in `src/lib/merge-import.ts`.
- **`?raw` CSS imports need `css: true` in `vitest.config.ts`.** Vitest stubs anything matching
  `*.css` to an empty module and that stub beats the raw loader, so without the flag the sheets
  arrive as empty strings and every token assertion passes vacuously.
- **`--accent` and `--accent-fg` must stay flat hexes.** `scripts/gen-icons.mjs` parses those exact
  declarations to colour the icon, so wrapping either in `light-dark()` throws the build. The same
  reason pins `minimum_chrome_version` to 123: `light-dark()` needs it.
- **`.spec-row` is a harness class.** It belongs to `design/preview.css` and to the artboards. The
  product renders `.row`. A harness class must never reach the shipped sheet.
- **`hasOnboarded` is true on every real install** by the time the welcome tab opens, because the
  starter pick is written first. It comes apart from "a pick is live" for a format 1 profile
  arriving from Settings, or an install whose write failed: those have every shipped shortcut on and
  no pick on record, so `initialPicks` opens the starter set ticked rather than an empty screen.

## Verify by executing, not by reading

The most valuable bugs here were found by *running* code, not inspecting it. The DNR regex looked
correct to three reviewers. Applying it to a real Chrome-generated URL exposed it immediately.
When you change routing, build the real rules and replay real URLs through them.

`buildRules` and the production path share `src/lib/dnr/rules.ts`, so what a `buildRules` test
omits is precisely `dnr/fit.ts`. `tests/helpers/rules.ts` has the matcher. `tests/sync-rules.test.ts` stubs `globalThis.chrome` and
exercises the **production** path. Note that only tests call `buildRules`, so a test that drives
`buildRules` alone is not testing what ships.

## Commands

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm build         # gen-icons + typecheck + vite build -> dist/
pnpm package       # build, then release/bunnylol-<version>.zip for the Web Store
```

Load `dist/` unpacked at `chrome://extensions` with Developer mode on. Other Chromium browsers work
the same way. Reload the extension after every build: editing source does not update a loaded
extension.

`pnpm build` regenerates the icons from `design/tokens.css` and the PNGs are committed, so CI runs
`git diff --exit-code -- public/icons store` after it. `pnpm package` writes to `release/`, which is
gitignored.

## Conventions

- pnpm, pinned via `packageManager`. Do not run `npm install`: it creates a second lockfile.
- TypeScript strict, `verbatimModuleSyntax`: use `import type` for type-only imports.
- Import siblings without a file extension.
- 2-space indent, single quotes, semicolons, no default exports.
- **No new dependencies.** The whole thing runs on four devDependencies; inline the functionality.
- Comment only where the *reason* is non-obvious. Do not restate the code.
- Vanilla TS and CSS in the UI. No framework.
- Colours, sizes and spacing in the UI sheets come from `design/tokens.css`. No literal hex, no raw
  `font-size: Npx`, and never `color: var(--accent)`. `tests/tokens.test.ts` enforces it. `--accent`
  is a fill (2.04:1 on white). `--accent-text` is the readable half-lightness twin for text, links
  and the focus ring.
- `src/lib` and `src/options/model` must import cleanly under vitest's `environment: node`: no
  `document`, no `chrome.*` at module scope. That is what makes the pure decisions testable without
  a DOM, and a stray import breaks a suite rather than a feature.
- Do not edit `extras/` expecting it to compile. It is intentionally outside tsconfig.
- `design/` is the approved design bundle. Change it through a design review, not in passing.

## Editing the command registry

Commands are plain data in `src/lib/commands.ts`. When adding or removing one:

- Aliases must be globally unique. `tests/commands.test.ts` asserts this.
- Every `handler` named must exist in `HANDLERS`, and every `HandlerId` must be used. Removing the
  last command that uses a handler orphans it. Remove the handler, its `HandlerId`, and any helper
  constants it alone used, or `noUnusedLocals` will fail the build.
- Removing a command can break tests that named it. Prefer rewriting such a test to derive its
  cases from `BUILTIN_COMMANDS` over substituting another command name.
- Pruned commands go into `extras/packs/removed-commands.json` verbatim rather than being deleted.
  It is an importable pack, not code. `extras/packs/README.md` documents the format.

## Known-unverified and deliberately-limited

- **Outlook deep-link search** (`outlook.office.com/mail/deeplink/search?query=`) is the widely
  documented OWA form but could not be confirmed. `outlook.office.com` returns 417 to
  unauthenticated requests. It needs one click-through in a signed-in mailbox.
- **Gemini has no URL prompt prefill** and never has. `gem` routes to Google's AI Mode
  (`?udm=50&q=`) instead.
- **Consumer Copilot strips `?q=`**, verified by isolation testing: `?q=` alone triggers a 302 to
  the bare home page, `?foo=1` does not. That command has since been removed entirely.
- AI prefill params are undocumented and change without notice. They all live in `AI_PROVIDERS` in
  `handlers.ts`, and `settings.aiTemplates` overrides one per provider id without a rebuild, though
  no settings card writes that map any more: a user reaches it by editing an export and importing it
  back. If one breaks, fix `AI_PROVIDERS`. Do not scatter URL templates.

## Review workflow

Project convention: substantial work arrives as **distinct commits sliced by architectural layer**,
so each one carries a single reviewable idea and passes the gate (`pnpm typecheck && pnpm test &&
pnpm build`) on its own. Verify that standing alone: a test that imports a module from a later
commit silently breaks the property without failing anything.

Those commits may be stacked as branches, each PR based on the previous one, or landed as one
branch. If you stack them, **do not pass `--delete-branch`** when merging: deleting a parent branch
auto-closes the child PR that targets it. Merge bottom-up without it, or retarget the tip to master
and merge once.

`CONTRIBUTING.md` is the same material written for a human contributor. Keep the two in step.
