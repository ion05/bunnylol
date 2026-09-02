## What this changes

## Which AGENTS.md invariant does this touch?
<!-- Name the numbered invariant, or write "none". If a test from that list
     fails, do not change the test. -->

## Checks
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] Loaded `dist/` unpacked and exercised the change in a real browser
- [ ] No new dependencies (devDependencies included)
- [ ] If routing/DNR changed: replayed a real Chrome-generated search URL
      through the built rules, not just `buildRules`
- [ ] Colours/sizes come from `design/tokens.css`, no literal hex or
      `font-size: Npx` in the UI sheets

## Stacked PRs
<!-- Base branch, and the PR this one sits on top of, if any. -->
