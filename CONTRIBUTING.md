# Contributing

Bug reports, new shortcuts and fixes are all welcome. Before you start:

- **[AGENTS.md](AGENTS.md) is the architecture note**, and its "Invariants that were violated during
  development" section is not decoration. Every entry is a bug that already shipped once. Every one
  has a regression test. And every one looks like reasonable code, which is why they came back. Read
  it before you touch routing, validation or the override layer.
- **No new dependencies in what ships.** Nothing is bundled into the extension but this repo's own
  source and one font. If you need a helper, inline it. Dev tooling is judged on its own merits and
  is currently jsdom, prettier and eslint on top of typescript, vite and vitest. Adding to that list
  is a decision somebody makes on purpose.

## Setup

```bash
pnpm install
pnpm build
```

Use pnpm, pinned by `packageManager` in package.json. Do not run `npm install`: it creates a second
lockfile. Node is pinned by `.nvmrc` (`nvm use` picks it up) and by `engines.node`. CI installs the
`.nvmrc` version, so that is the one to develop against.

Load `dist/` unpacked at `chrome://extensions` with Developer mode on. Press the reload arrow on the
extension card after every build.

## The gate

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

All four, green, on **every** commit, not just at the end of a branch. CI runs exactly this on pull
requests, plus `git diff --exit-code -- public/icons store`. `pnpm lint` goes first because it is
the fastest of the four and the cheapest to fix. `pnpm build` regenerates the icons from
`design/tokens.css`. So if you change the generator or the accent colour and do not commit the
result, it shows up as a dirty tree.

`pnpm build` is also the typecheck of record. `pnpm build:fast` skips it when you are iterating.

## Verify by executing, not by reading

The most valuable bugs in this repo were found by *running* code. The redirect regex looked correct
to several readers. Applying it to a real Chrome-generated URL exposed the bug immediately. If you
change routing, build the real rules and replay real URLs through them. `tests/helpers/rules.ts` has
the matcher. Then load the extension and try it.

When you add a test, make sure it fails when the thing it guards is broken. Break the code, watch it
go red, put it back.

## Adding or changing a command

Commands are plain data in `src/lib/commands.ts`.

- **Aliases are globally unique.** `tests/commands.test.ts` asserts it.
- Every `handler` you name must exist in `HANDLERS`, and some command must use every `HandlerId`.
  Removing the last command that uses a handler orphans it. Remove the handler, its `HandlerId` and
  any constant only it used, or `noUnusedLocals` fails the build.
- **Free text never goes into a slot that expects a shape.** A tracking number, a meeting id or a
  phone number has to be validated and degrade to a search. Otherwise `fedex near me open now`
  renders "tracking number not found".
- **No command opens something with a write side effect by default.** Creating a task lives on its
  own alias: `td` searches, `tda` adds.
- Removing a command can break a test that named it. Prefer rewriting that test to derive its cases
  from `BUILTIN_COMMANDS` over swapping in another command name.
- Commands pruned from the registry go into `extras/packs/removed-commands.json` verbatim rather
  than being deleted, so anyone who used one can import it back. See
  [`extras/packs/README.md`](extras/packs/README.md).

A shortcut only *you* need does not need a PR at all. Make it in the options page, or write a pack.

## Style

- TypeScript strict, `verbatimModuleSyntax`: `import type` for type-only imports.
- Import siblings without a file extension.
- 2-space indent, single quotes, semicolons, no default exports.
- Vanilla TS and CSS in the UI. No framework.
- Colours, sizes and spacing in the UI stylesheets come from `design/tokens.css`. No literal hex, no
  raw `font-size: Npx`, and never `color: var(--accent)`, because the sand accent is a fill and
  fails contrast as text. `tests/tokens.test.ts` enforces all of it.
- **Comment only where the reason is non-obvious.** Do not restate the code. A comment that says
  *why this and not the obvious alternative* is worth more than five that narrate what the next line
  does.
- User text reaches the DOM only through `textContent` and `createElement`. A shortcut name is
  untrusted input.

`import type`, the indent, the quotes, the semicolons and the ban on default exports are all
enforced now. `pnpm lint` runs eslint and `prettier --check`; `pnpm format` rewrites the files.
Prettier is set to the style already here rather than the other way round, so running it over a
clean tree changes nothing.

Both configs are short and commented. Every rule eslint has switched off names the convention it was
fighting, so if a rule is in your way, read why it is off before turning it back on. Four things are
outside the formatter on purpose: `design/` is the approved design bundle and changes through a
design review, `go.html` carries a deliberately minified inline stylesheet that
`tests/tokens.test.ts` matches as text, Markdown is hand-wrapped prose, and `pnpm-lock.yaml` belongs
to pnpm.

## Pull requests

The [template](.github/PULL_REQUEST_TEMPLATE.md) asks for the checks you ran, which AGENTS.md
invariant the change touches, and whether you exercised it in a real browser. Fill it in. "None" is
a fine answer to the invariant question.

Commit subjects are imperative and fit in 72 characters, with no trailing period. The body explains
*what changed and why*, wrapped at about 80 columns. The why is the part you cannot recover from the
diff later.

For anything substantial, this project splits the work into ordered commits sliced by architectural
layer. Each one then carries a single reviewable idea and passes the gate on its own. A test that
imports a module from a later commit quietly breaks that, so check each commit standing alone. If
you stack branches, merge them bottom-up **without** `--delete-branch`. Deleting a parent branch
auto-closes the PR that targets it.

## Security

Do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) has the private reporting
route.

## Maintenance and releases

This project is maintained by one person, [@ion05](https://github.com/ion05). Issues and pull
requests are read, but a reply may take a week. That is the honest expectation rather than a
promise of anything faster.

Versions follow [semantic versioning](https://semver.org), and the stored state format is the
compatibility surface. A new field that older builds ignore is a minor. A change that makes an
older export unreadable is a major. Adding or removing a shipped shortcut is a minor, since a
profile that never touched it still resolves.

A release is:

1. Bump `version` in `package.json` and `public/manifest.json` in the same commit. They are checked
   against each other by `tests/manifest.test.ts`, so they cannot drift.
2. Add the section to [CHANGELOG.md](CHANGELOG.md) and the link at the foot of that file.
3. Run the gate, then `pnpm package`, which rebuilds and writes `release/bunnylol-<version>.zip`.
   Build fresh rather than trusting a zip already sitting in `release/`: the Web Store enforces
   monotonic versions, so uploading a stale build under a new version costs you the next one too.
4. Tag `vX.Y.Z`, push the tag, and attach that zip to a GitHub release.
5. Upload the same zip to the Web Store. [docs/chrome-web-store.md](docs/chrome-web-store.md) has
   the dashboard answers, and [store/listing.md](store/listing.md) has the copy.
