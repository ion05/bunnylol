# Contributing

Bug reports, new shortcuts and fixes are all welcome. Two things to know before you start:

- **[AGENTS.md](AGENTS.md) is the architecture note**, and its "Invariants that were violated during
  development" section is not decoration. Every entry is a bug that already shipped once, every one
  has a regression test, and every one looks like reasonable code — which is why they came back.
  Read it before touching routing, validation or the override layer.
- **No new dependencies**, devDependencies included. The whole project runs on a handful of build
  tools; if you need a helper, inline it.

## Setup

```bash
pnpm install
pnpm build
```

pnpm, pinned by `packageManager` in package.json — do not run `npm install`, it creates a second
lockfile. Node is pinned by `.nvmrc` (`nvm use` picks it up) and by `engines.node`; CI installs the
`.nvmrc` version, so that is the one to develop against.

Load `dist/` unpacked at `chrome://extensions` with Developer mode on, and press the reload arrow on
the extension card after every build.

## The gate

```bash
pnpm typecheck && pnpm test && pnpm build
```

All three, green, on **every** commit — not just at the end of a branch. CI runs exactly this on
pull requests, plus `git diff --exit-code -- public/icons store`: `pnpm build` regenerates the icons
from `design/tokens.css`, so a change to the generator or to the accent colour that was not
committed shows up as a dirty tree.

`pnpm build` is also the typecheck of record. `pnpm build:fast` skips it when you are iterating.

## Verify by executing, not by reading

The most valuable bugs in this repo were found by *running* code. The redirect regex looked correct
to several readers; applying it to a real Chrome-generated URL exposed the bug immediately. If you
change routing, build the real rules and replay real URLs through them — `tests/helpers/rules.ts`
has the matcher — and load the extension and try it.

When you add a test, make sure it fails when the thing it guards is broken. Break the code, watch it
go red, put it back.

## Adding or changing a command

Commands are plain data in `src/lib/commands.ts`.

- **Aliases are globally unique**; `tests/commands.test.ts` asserts it.
- Every `handler` you name must exist in `HANDLERS`, and every `HandlerId` must be used by some
  command. Removing the last command that uses a handler orphans it — remove the handler, its
  `HandlerId` and any constant only it used, or `noUnusedLocals` fails the build.
- **Free text never goes into a slot that expects a shape.** A tracking number, a meeting id or a
  phone number has to be validated and degrade to a search, or `fedex near me open now` renders
  "tracking number not found".
- **No command opens something with a write side effect by default.** Creating a task lives on its
  own alias (`td` searches, `tda` adds).
- Removing a command can break a test that named it. Prefer rewriting that test to derive its cases
  from `BUILTIN_COMMANDS` over swapping in another command name.
- Commands pruned from the registry go into `extras/packs/removed-commands.json` verbatim rather
  than being deleted, so anyone who used one can import it back. See
  [`extras/packs/README.md`](extras/packs/README.md).

Adding a shortcut only *you* need does not require a PR at all — make it in the options page, or
write a pack.

## Style

- TypeScript strict, `verbatimModuleSyntax`: `import type` for type-only imports.
- Import siblings without a file extension.
- 2-space indent, single quotes, semicolons, no default exports.
- Vanilla TS and CSS in the UI. No framework.
- Colours, sizes and spacing in the UI stylesheets come from `design/tokens.css`. No literal hex,
  no raw `font-size: Npx`, and never `color: var(--accent)` — the sand accent is a fill and fails
  contrast as text. `tests/tokens.test.ts` enforces all of it.
- **Comment only where the reason is non-obvious.** Do not restate the code. A comment that says
  *why this and not the obvious alternative* is worth more than five that narrate what the next line
  does.
- User text reaches the DOM only through `textContent` / `createElement`. A shortcut name is
  untrusted input.

There is no linter or formatter, deliberately — one fewer dependency and one fewer config to argue
with. Match the surrounding code.

## Pull requests

The [template](.github/PULL_REQUEST_TEMPLATE.md) asks for the checks you ran, which AGENTS.md
invariant the change touches, and whether you exercised it in a real browser. Fill it in; "none" is
a fine answer to the invariant question.

Commit subjects are imperative and fit in 72 characters, with no trailing period. The body explains
*what changed and why*, wrapped at about 80 columns — the why is the part that cannot be recovered
from the diff later.

For anything substantial, this project splits the work into ordered commits sliced by architectural
layer, so each one carries a single reviewable idea and passes the gate on its own. A test that
imports a module from a later commit quietly breaks that, so check each commit standing alone. If
you stack branches, merge them bottom-up **without** `--delete-branch` — deleting a parent branch
auto-closes the PR that targets it.

## Security

Do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) has the private reporting
route.
