# AGENTS.md

Context for AI coding agents working in this repo. Read this before changing anything.

`README.md` documents the extension for someone *using* it. This file is for someone *changing* it.

## What this is

A Chrome Manifest V3 extension that turns the address bar into a command line — a personal clone
of Meta's internal BunnyLol. Type `gh facebook/react` and land on the repo, not a search results
page. Built for one user: a Purdue CS student who lives in GitHub, Claude/ChatGPT, Brightspace,
Gradescope and the Microsoft 365 suite, and who runs Chrome, Brave and Dia.

91 builtin commands: ai 6, google 10, microsoft 8, purdue 8, dev 15, search 11, social 11,
productivity 19, meta 3.

## The one decision that explains everything

**The first word of an address-bar query is ALWAYS a command when it matches a registered
keyword.** `c programming tutorial` goes to Claude. `pr firms in new york` goes to the user's
GitHub pull requests. This is deliberate — it is how Meta's bunnylol works — and it was chosen
explicitly over three alternatives (an opt-in allowlist, a sigil prefix, and a curated blocklist)
after the blocklist approach failed to converge: a verifier found ~111 of 271 aliases could hijack
some plausible English search, and blocking those only surfaces the next tier.

The escape hatch is therefore load-bearing, not a nicety. A leading `\` or `=`
(`FORCE_SEARCH_PREFIXES` in `types.ts`) forces a plain search. If you weaken the escape path, you
break the entire product.

`Settings.interceptStopList` exists as a user-curated *exemption* list and **defaults to empty**
(`DEFAULT_STOP_LIST`). Do not repopulate it as a blocklist — that was tried and rejected.

## Architecture

```
src/lib/types.ts        The frozen contract. Everything imports it. No chrome.*, no DOM.
src/lib/commands.ts     91 builtin commands + SEARCH_ENGINES
src/lib/handlers.ts     Smart argument handlers + AI_PROVIDERS
src/lib/resolve.ts      resolve(query, commands, settings) -> ResolveResult. Pure. The brain.
src/lib/validate.ts     The single validation boundary for aliases and URLs
src/lib/storage.ts      chrome.storage.local persistence, JSON import/export
src/lib/dnr.ts          declarativeNetRequest rule generation + syncRules
src/lib/url.ts          Small URL helpers
src/background.ts       MV3 service worker: rule sync, omnibox
src/go/go.ts            Dispatch page — resolves and navigates
src/options/            Shortcut manager UI (options.ts, status.ts, options.css)
src/popup/              Toolbar command bar
extras/removed-commands.ts   Pruned commands, kept verbatim. Outside tsconfig; not compiled.
```

`resolve.ts` is pure and shared by every surface — dispatch page, omnibox, popup, options live
preview, tests. Behaviour cannot drift between surfaces because there is one code path. Keep it
that way: no `chrome.*` and no DOM in `resolve.ts`.

Handlers (`HandlerId` in types.ts): github, githubPulls, githubIssues, githubGist, reddit, npm,
gmail, gdrive, gcal, googleApp, outlook, onedrive, teams, ai, brightspace, gradescope, youtube,
meta, zoom, meet, tracking, instagram, whatsapp, word.

## Invariants that were violated during development

Every one of these was a real shipped bug caught by adversarial verification. They have regression
tests. **If a test in this list fails, do not "fix" the test.**

1. **BunnyLol must never intercept its own output.** Some commands resolve to a URL on a search
   engine we intercept (`g`, `ddg`, and historically `weather`). `destination()` in `resolve.ts`
   marks these with the passthrough param so the higher-priority allow rules claim them. Without
   it `weather` looped infinitely and `g npm install` landed on npmjs.com.
   Guarded by `tests/self-interception.test.ts`, which derives the at-risk set **from the rules**
   (every command whose resolved URL a redirect rule would actually claim back) rather than naming
   commands — so it cannot silently become vacuous when a command is removed.

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
   longest-first so `github` beats `gh`, but truncating *that* order removes exactly the short hot
   aliases — at ~400 custom shortcuts `gh`, `g` and `npm` silently stopped being intercepted.

6. **All alias and URL validation goes through `src/lib/validate.ts`.** It has three callers: the
   import parser, the custom-shortcut form, and the builtin key editor. When the rule lived in
   whichever module needed it, each had a different hole — whitespace aliases and scheme-less URLs
   both persisted happily while being unusable. `validateAlias` also rejects an alias starting with
   an escape prefix, since `resolve()` strips that before the key map is ever consulted.

7. **Free text never goes into a slot expecting a specific shape.** Tracking numbers, Zoom meeting
   ids, phone numbers and dictionary headwords all guard their input and degrade to a search.
   Otherwise `fedex near me open now` renders "tracking number not found".

8. **Arguments are never silently dropped** — with one deliberate, enumerated exception. The cloud
   consoles (`aws`, `gcp`, `vercel`, `netlify`, `cf`) had their `site:` doc search removed on
   request and are pure jumps now. They are listed by name in `tests/commands.test.ts` so adding a
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
    ids and both add them; Chrome refuses the second and `failClosed` answers a refusal by tearing
    the whole dynamic table down, leaving no address-bar interception at all. A burst of saves —
    one `onStateChanged` per onboarding write — is exactly that pattern. The fast path consults the
    trailing slot **before** the in-flight slot, because `chain` is cleared a microtask or two
    before the follow-up it scheduled starts, and a caller landing in that gap would otherwise open
    a third rebuild alongside it. Guarded by `tests/sync-rules.test.ts` `describe('concurrent
    syncs')`, which can only see the collision because `StubOptions.strictIds` reproduces Chrome's
    duplicate-id refusal — a burst against the unserialized path costs 7 writes and an empty rule
    table, and the naive chain-only ordering fails the sweep at arrival tick 105.

## Verify by executing, not by reading

The most valuable bugs here were found by *running* code, not inspecting it. The DNR regex looked
correct to three reviewers; applying it to a real Chrome-generated URL exposed it immediately.
When you change routing, build the real rules and replay real URLs through them.

`tests/helpers/rules.ts` has the matcher. `tests/sync-rules.test.ts` stubs `globalThis.chrome` and
exercises the **production** path — note that `buildRules` is only called by tests, so a test that
drives `buildRules` alone is not testing what ships.

## Commands

```bash
pnpm install
pnpm test          # vitest, 666 tests across 10 suites
pnpm typecheck     # tsc --noEmit
pnpm build         # gen-icons + typecheck + vite build -> dist/
```

Load `dist/` unpacked at `chrome://extensions` with Developer mode on. Also works in Brave
(`brave://extensions`) and Dia. Reload the extension after every build — editing source does not
update a loaded extension.

## Conventions

- pnpm, pinned via `packageManager`. Do not run `npm install` — it creates a second lockfile.
- TypeScript strict, `verbatimModuleSyntax` — use `import type` for type-only imports.
- Import siblings without a file extension.
- 2-space indent, single quotes, semicolons, no default exports.
- **No new dependencies.** The whole thing runs on four devDependencies; inline the functionality.
- Comment only where the *reason* is non-obvious. Do not restate the code.
- Vanilla TS and CSS in the UI. No framework.
- Do not edit `extras/` expecting it to compile — it is intentionally outside tsconfig.

## Editing the command registry

Commands are plain data in `src/lib/commands.ts`. When adding or removing one:

- Aliases must be globally unique — `tests/commands.test.ts` asserts this.
- Every `handler` named must exist in `HANDLERS`, and every `HandlerId` must be used. Removing the
  last command that uses a handler orphans it; remove the handler, its `HandlerId`, and any helper
  constants it alone used, or `noUnusedLocals` will fail the build.
- Removing a command can break tests that named it. Prefer rewriting such a test to derive its
  cases from `BUILTIN_COMMANDS` over substituting another command name.
- Pruned commands go into `extras/removed-commands.ts` verbatim rather than being deleted.

## Known-unverified and deliberately-limited

- **Outlook deep-link search** (`outlook.office.com/mail/deeplink/search?query=`) is the widely
  documented OWA form but could not be confirmed — `outlook.office.com` returns 417 to
  unauthenticated requests. Needs one click-through in a signed-in mailbox.
- **Gemini has no URL prompt prefill** and never has. `gem` routes to Google's AI Mode
  (`?udm=50&q=`) instead.
- **Consumer Copilot strips `?q=`** — verified by isolation testing: `?q=` alone triggers a 302 to
  the bare home page, `?foo=1` does not. That command has since been removed entirely.
- AI prefill params are undocumented and change without notice. They all live in `AI_PROVIDERS` in
  `handlers.ts` and are editable from the options page without a rebuild. If one breaks, fix it
  there — do not scatter URL templates.

## Review workflow

The user wants substantial work delivered as **distinct commits on stacked branches**, each PR
based on the previous one, sliced by architectural layer so each PR carries one reviewable idea.
Verify each commit stands alone (typecheck + its own tests pass) before pushing — a test importing
a module from a later commit silently breaks that property.

Pushes to this remote reject commits authored with a real email address; use the GitHub noreply
form (`49789627+ion05@users.noreply.github.com`).

When merging a stack, **do not pass `--delete-branch`**: deleting a parent branch auto-closes the
child PR that targets it. Merge bottom-up without it, or retarget the tip to master and merge once.
