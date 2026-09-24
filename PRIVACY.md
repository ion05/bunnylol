# Privacy Policy

Last updated: 2026-09-24

## Summary

BunnyLol collects nothing and transmits nothing. It contains no analytics, no
telemetry, no remote code and no network requests of its own.

## What is stored and where

BunnyLol keeps one JSON value under the key `bunnylol.state.v1` (`STORAGE_KEY`
in `src/lib/types.ts`) in `chrome.storage.local` on your device (`saveState`
in `src/lib/storage.ts`). It holds your custom shortcuts, any shipped
shortcuts you turned off or edited, and your settings. The settings include
`dismissedSuggestions`, the hostnames of any shortcut suggestions you
dismissed (see below), and nothing else about the sites you visit. Like the
rest of the state, that list is in the exported file. Nothing is written to
`chrome.storage.sync`. Uninstalling the extension deletes it.

The extension also caches its rule-registration status under
`bunnylol.ruleStatus.v1` in `chrome.storage.session`. That cache lives only
until the browser closes and never reaches disk. It holds counts and, when
Chrome rejects a pattern, the affected keywords.

The options page keeps one more value, `bunnylol.collapsed`, in the ordinary
`localStorage` of its own extension page (`COLLAPSE_KEY` in
`src/options/model/collapse.ts`). It is the list of shortcut groups you have
folded on that page, and nothing else. It is per-machine view state rather
than settings, which is why it is not in the exported file.

## What happens when you type in the address bar

BunnyLol registers local `declarativeNetRequest` redirect rules for
`www.google.com`, `www.bing.com` and `duckduckgo.com` (`SEARCH_ENGINES` in
`src/lib/commands.ts`, rules built by `redirectRule` in `src/lib/dnr.ts`).
A navigation to one of those result pages begins. If the first word matches
one of your keywords, Chrome rewrites the URL to the extension's own
`go.html` page **before the request leaves the browser**. Local JavaScript
then reads the query string, and it never goes anywhere else. Searches that
do not match are left untouched and go to the search engine as normal.

## What the extension can see

BunnyLol does not request the `tabs` permission. It has no access to your
browsing history unless you opt in, as described below. Three places open a tab, and all of them use only
`chrome.tabs.create` and `chrome.tabs.update`, which do not require that
permission: the toolbar popup (`src/popup/popup.ts`), the omnibox keyword
(`src/background.ts`), and the welcome tab shown once on install
(`src/lib/install.ts`). Neither call can read a tab, only point one at a URL.

The one content script is `src/content/amazon-goodreads.ts`, injected only on
`amazon.com` product pages. It reads the page locally to find a labelled ISBN
(or a JSON-LD `isbn`) and, when it finds one, draws a button. Clicking that
button navigates your tab to Goodreads. The ISBN never leaves the browser
except as the path of that navigation you started. Pages without an ISBN are
untouched. No other site is injected into.

### Shortcut suggestions (opt-in)

`history` is an optional permission (`optional_permissions` in
`public/manifest.json`). BunnyLol asks for it only when you click **Suggest
shortcuts**, on the Shortcuts page or the welcome screen, and Chrome shows
its own prompt. Until you accept, the extension cannot read your history.

With the permission granted, the options page and the toolbar popup call
`chrome.history.search` for the last 90 days when they open (`loadSuggestions`
in `src/lib/history.ts`). The visits are ranked locally (`suggestShortcuts` in
`src/lib/suggest.ts`) into a few sites you might want a keyword for. Sites a
shortcut already reaches, search engines, `localhost`, IP addresses and hosts
you dismissed are skipped. The visits are never stored and never sent
anywhere; they are read again the next time either page opens. The only
thing kept is the hostname of a suggestion you dismiss with ×.

To revoke the permission, open `chrome://extensions`, click **Details** on
BunnyLol and remove it under **Permissions**, or remove it from Chrome's
extension permission settings. Suggestions stop, and nothing else changes.

## Third parties

None. A shortcut may navigate you to a third-party site such as GitHub or
Gmail. From that point on, that site's own privacy policy applies. BunnyLol
itself is not a party to that visit.

## Remote code

None. BunnyLol ships no `eval` and no `new Function`, and it loads no code
from a CDN or any other remote source. Everything that runs is in this
repository.

## Changes to this policy

Any change to this policy is announced in [CHANGELOG.md](CHANGELOG.md).

## Contact

Questions or concerns: open an issue at
https://github.com/ion05/bunnylol/issues.
