# AGENTS.md

Context for AI coding agents working in this repo. Read this before changing anything.

Human-facing usage docs are in `README.md`; this file is about *modifying* the extension.

## What this is

A Chrome Manifest V3 extension that turns the address bar into a command line — a personal clone
of Meta's internal BunnyLol. Type `gh facebook/react` and land on the repo, not a search results
page. Built for one user: a Purdue CS student who lives in GitHub, Claude/ChatGPT, Brightspace,
Gradescope and the Microsoft 365 suite, and who runs Chrome, Brave and Dia.

## The one decision that explains everything

**The first word of an address-bar query is ALWAYS a command when it matches a registered
keyword.** `c programming tutorial` goes to Claude. `pr firms in new york` goes to the user's
GitHub pull requests. This is deliberate — it is how Meta's bunnylol works — and it was chosen
explicitly over three alternatives after a blocklist approach failed to converge (a verifier found
~111 of 271 aliases could hijack some plausible English search; blocking those only surfaces the
next tier).

The escape hatch is therefore load-bearing, not a nicety. A leading `\` or `=` forces a plain
search. If you weaken the escape path, you break the entire product.

`Settings.interceptStopList` exists as a user-curated *exemption* list and defaults to empty. Do
not repopulate it as a blocklist — that decision was made and rejected.

## Architecture

```
src/lib/types.ts        The frozen contract. Everything imports it. No chrome.*, no DOM.
src/lib/commands.ts     ~170 builtin commands + SEARCH_ENGINES
src/lib/handlers.ts     Smart argument handlers + AI_PROVIDERS
src/lib/resolve.ts      resolve(query, commands, settings) -> ResolveResult. Pure. The brain.
src/lib/storage.ts      chrome.storage.local persistence, JSON import/export
src/lib/dnr.ts          declarativeNetRequest rule generation + syncRules
src/background.ts       MV3 service worker: rule sync, omnibox
src/go/go.ts            Dispatch page — resolves and navigates
src/options/            Shortcut manager UI (vanilla TS + CSS)
src/popup/              Toolbar command bar
```

`resolve.ts` is pure and shared by every surface — dispatch page, omnibox, popup, options live
preview, tests. Behaviour cannot drift between surfaces because there is one code path. Keep it
that way: no `chrome.*` and no DOM in `resolve.ts`.

## Invariants that were violated during development

Every one of these was a real shipped bug caught by adversarial verification. They have regression
tests. If a test in this list fails, do not "fix" the test.

1. **BunnyLol must never intercept its own output.** Several commands resolve to a URL on a search
   engine we intercept — `weather`, `g`, `bing`, `ddg`, `gimg`, `gvid`, `gbooks`, `gsite`, the
   Gemini AI-mode template. `destination()` in `resolve.ts` marks these with the passthrough
   param so the higher-priority allow rules claim them. Without it `weather` loops infinitely and
   `g npm install` lands on npmjs.com instead of Google results.
   Guarded by `tests/self-interception.test.ts`, driven off `BUILTIN_COMMANDS` so a new offending
   command fails automatically.

2. **DNR rule priority is `redirect (1) < escape (2) < allow (3)`,** and `fitPlan` fails closed:
   an engine gets redirect rules only if Chrome accepted both its allow and escape rules.
   Registering redirects without them leaves the user in a redirect loop with no escape.

3. **The DNR regex must consume the whole URL remainder,** not just the terminator. Chrome appends
   `&sourceid=chrome&ie=UTF-8` (Bing: `&PC=U316&FORM=CHROMN`, DDG: `&t=hc`) to address-bar
   searches. RE2 has no lookahead, so the pattern swallows the tail and the substitution drops it.
   Otherwise every real interception gets trailing junk glued onto the query.

4. **Keyword retention is ranked separately from alternation ordering.** The alternation must be
   longest-first so `github` beats `gh`, but truncating *that* order removes exactly the short hot
   aliases — at ~400 custom shortcuts `gh`, `g` and `npm` silently stopped being intercepted.

5. **Free text never goes into a slot expecting a specific shape.** Tracking numbers, Zoom meeting
   ids, localhost ports, phone numbers, tickers, dictionary headwords all guard their input and
   degrade to a search. Otherwise `fedex near me open now` renders "tracking number not found".

6. **Arguments are never silently dropped.** Login-walled sites with no search route fall through
   to a `site:` or plain search rather than discarding what the user typed.

7. **No command may have a write side effect as its default argument behaviour.** `td bank near me`
   used to open Todoist's quick-add *prefilled*. Quick-add lives on a separate `tda` alias.

8. **`buildKeyMap` is first-writer-wins** and `mergeCommands` puts custom commands first, so a
   user's own `gh` shadows the builtin rather than being ignored.

9. **User text reaches the DOM only via `textContent`/`createElement`.** A shortcut name is
   untrusted input. `background.ts` XML-escapes omnibox descriptions or Chrome silently drops the
   suggestion.

10. **`resolve()` never throws.** A handler that blows up degrades to the command's bare
    destination.

## Verify by executing, not by reading

The most valuable bugs in this project were found by *running* code, not inspecting it. The DNR
regex looked correct to three reviewers; applying it to a real Chrome-generated URL exposed it
immediately. When you change routing, build the real rules and replay real URLs through them.

`tests/helpers/rules.ts` has the matcher. `tests/sync-rules.test.ts` stubs `globalThis.chrome` and
exercises the *production* path — note that `buildRules` is only called by tests, so a test that
drives `buildRules` alone is not testing what ships.

## Commands

```bash
pnpm install
pnpm test          # vitest, 750 tests
pnpm typecheck     # tsc --noEmit
pnpm build         # gen-icons + typecheck + vite build -> dist/
```

Load `dist/` unpacked at `chrome://extensions` with Developer mode on.

## Conventions

- TypeScript strict, `verbatimModuleSyntax` — use `import type` for type-only imports.
- Import siblings without a file extension.
- 2-space indent, single quotes, semicolons, no default exports.
- No new dependencies. The whole thing runs on four devDependencies; inline the functionality
  instead.
- Comment only where the *reason* is non-obvious. Do not restate the code.
- Vanilla TS and CSS in the UI. No framework.

## Known-unverified and deliberately-limited

- **Outlook deep-link search** (`outlook.office.com/mail/deeplink/search?query=`) is the widely
  documented OWA form but could not be confirmed — `outlook.office.com` returns 417 to
  unauthenticated requests. Needs one click-through in a signed-in mailbox.
- **Gemini has no URL prompt prefill** and never has. `gem` routes to Google's AI Mode
  (`?udm=50&q=`) instead.
- **Consumer Copilot strips `?q=`** — verified by isolation testing: `?q=` alone triggers a 302 to
  the bare home page, `?foo=1` does not. `copilot` opens the app rather than pretending.
- AI prefill params are undocumented and change without notice. They all live in `AI_PROVIDERS` in
  `handlers.ts` and are editable from the options page without a rebuild. If one breaks, fix it
  there — do not scatter URL templates.

## Review workflow

The user wants substantial work delivered as **distinct commits on stacked branches**, each PR
based on the previous one, sliced by architectural layer so each PR carries one reviewable idea.
Verify each commit stands alone (typecheck + its own tests pass) before pushing — a test importing
a module from a later commit silently breaks that property.

Pushes to this remote reject commits authored with a real email address; use the GitHub noreply
form.
