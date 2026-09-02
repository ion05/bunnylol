# Privacy Policy

Last updated: 2026-09-01

## Summary

BunnyLol collects nothing, transmits nothing, and contains no analytics, no
telemetry, no remote code and no network requests of its own.

## What is stored and where

BunnyLol keeps one JSON value under the key `bunnylol.state.v1` (`STORAGE_KEY`
in `src/lib/types.ts`) in `chrome.storage.local` on your device (`saveState`
in `src/lib/storage.ts`). It holds your custom shortcuts, any shipped
shortcuts you turned off or edited, and your settings. Nothing is written to
`chrome.storage.sync`. Uninstalling the extension deletes it.

The extension also caches its rule-registration status under
`bunnylol.ruleStatus.v1` in `chrome.storage.session`, which lives only until
the browser closes and never reaches disk; it holds counts and, when Chrome
rejects a pattern, the affected keywords.

## What happens when you type in the address bar

BunnyLol registers local `declarativeNetRequest` redirect rules for
`www.google.com`, `www.bing.com` and `duckduckgo.com` (`SEARCH_ENGINES` in
`src/lib/commands.ts`, rules built by `redirectRule` in `src/lib/dnr.ts`).
When a navigation to one of those result pages begins and the
first word matches one of your keywords, Chrome rewrites the URL to the
extension's own `go.html` page **before the request leaves the browser**. The
query string is then read by local JavaScript and never sent anywhere.
Non-matching searches are left untouched and go to the search engine as
normal.

## What the extension cannot see

BunnyLol has no content scripts, reads no page content, and has no access to
your browsing history. It does not request the `tabs` permission — the popup
uses only `chrome.tabs.create`/`chrome.tabs.update` (`src/popup/popup.ts`),
which do not require it.

## Third parties

None. When a shortcut navigates you to a third-party site — GitHub, Gmail,
whatever the shortcut points at — that site's own privacy policy applies from
that point on. BunnyLol itself is not a party to that visit.

## Remote code

None. BunnyLol ships no `eval`, no `new Function`, and loads no code from a
CDN or any other remote source. Everything that runs is in this repository.

## Changes to this policy

Any change to this policy is announced in [CHANGELOG.md](CHANGELOG.md).

## Contact

Questions or concerns: open an issue at
https://github.com/ion05/bunnylol/issues.
