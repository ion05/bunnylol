# BunnyLol

BunnyLol turns the Chrome address bar into a command line. Type a keyword and its arguments and you
land on the page itself, not on a results page for it:

```
gh facebook/react   →   github.com/facebook/react
npm zod             →   npmjs.com/package/zod
c explain monads    →   Claude, with the prompt already in the box
```

It is an independent, unofficial project inspired by the bunnylol-style command bar used inside
Meta. **Not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc.**

Manifest V3, no dependencies at runtime, no network requests of its own, and nothing leaves your
machine — see [PRIVACY.md](PRIVACY.md).

## Install from source

There is no store listing yet. Build it and load it unpacked:

```bash
pnpm install
pnpm build
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repo's `dist/` folder.

Rebuild with `pnpm build` after pulling, then press the reload arrow on the extension card — editing
source does not update a loaded extension.

**Chrome 123 or newer.** The UI's colours are declared with CSS `light-dark()`, which Chrome added
in 123; on anything older every themed colour falls back to `unset` and the pages are unreadable.
`minimum_chrome_version` in the manifest records the same floor. Other Chromium browsers work the
same way — the MV3 manifest, the service worker and the redirect rules behave identically — though
a fork that routes the omnibox itself may not hand over address-bar navigations, in which case the
toolbar popup and `bl` + Tab still work.

## First run

The first install opens a **welcome screen** that asks one question: which packs of shipped
shortcuts do you want? Only three are ticked — **Search**, **Developer** and **AI**. Every other
pack is offered unticked, and its shortcuts start switched off: **Google**, **Microsoft**,
**Social**, **Productivity**, and, under *Optional packs*, **Purdue** — one university's tooling,
dead weight for everyone else. Closing the tab without answering keeps that starter set, because
the pick is written before the screen opens, so it is already live.

Nothing there is final. Every shortcut can be renamed, moved, switched off or deleted afterwards,
and **Settings → Sections → Shortcut packs → Choose shortcut packs…** reopens the screen — that
is how you turn a pack on later. Note what Continue means when you do: it turns *on* every
shipped shortcut in the packs you tick, including ones you had switched off by hand, and turns
off the ones in the packs you leave unticked. Shortcuts you made yourself are never touched.

## How triggering works

**The first word wins.** If the first word of what you type in the address bar is a keyword you
have, it is a command — always, no heuristics. `c programming tutorial` opens Claude with that
prompt. `pr firms in new york` opens your GitHub pull requests. `map of france` opens Google Maps.
That is the contract, and it is what makes the address bar predictable: you never wonder whether a
keyword will fire this time.

The other half of it is how to say *no, actually search for that*, and it is one keystroke:

| Type this | You get |
|---|---|
| `\gh foo` | A plain search for **gh foo**. A leading backslash escapes the whole query. |
| `=gh foo` | Identical. `=` is the same escape, one unshifted key on every layout. |
| `g wagon price` | A Google search for **wagon price** — `g` is the "search Google" command and its argument is what gets searched. |
| `ddg …` | The same, on DuckDuckGo. |

Note the difference between the first two rows and the third. To search for the literal phrase
**g wagon price**, escape it: `\g wagon price`. Same for `pr` (`\pr firms in new york`) and anything
else. The escape character is stripped before the search — it never reaches the engine as a search
term — and it works on every surface, because they all run the same resolver.

### The three ways in

Google stays your real default search engine. Nothing about your browser settings changes.

- **Address bar (primary).** A `declarativeNetRequest` rule matches search URLs whose query starts
  with a keyword you have, and redirects them to the extension's local dispatch page before any
  request leaves your machine. That page resolves the keyword and replaces itself with the
  destination:

  ```
  google.com/search?q=gh+facebook/react   →   go.html?q=gh facebook/react   →   github.com/facebook/react
  ```

  A separate, higher-priority rule matches a query that *starts* with an escape character — in both
  its raw and percent-encoded forms, because Chrome sends `\` to the engine as `%5C` — so `\gh foo`
  is intercepted too and turned into a clean search for "gh foo". Rules are rebuilt from your live
  keyword list whenever you change a shortcut, so an ordinary search like `how tall is the eiffel
  tower` never matches and is not slowed down. Bing and DuckDuckGo are intercepted the same way, and
  each engine can be switched off in Settings.

- **Omnibox keyword (fallback).** Type `bl`, press **Tab**, then your command. This path does not
  depend on redirect rules at all, so it is the safety net if interception behaves differently in
  your browser — and it is where an exempted keyword (below) still works.

- **Toolbar popup.** Click the BunnyLol icon for a command bar with autocomplete over the same
  registry — handy when you are already on a page.

All three run the same resolver, so a shortcut behaves identically no matter how you invoke it.

### Why an escape hatch and not a list of "safe" words

BunnyLol used to ship a stop list: keywords like `map`, `news`, `mail` and `so` left out of
address-bar interception because they were plausible first words of ordinary searches. That list is
gone and the default is empty.

It was an endless tail. A large fraction of the keywords that remained eligible could still hijack
some plausible English query, and blocking those only surfaced the next tier — `td`, `iss`, `bs`,
`gs`. Worse, it made behaviour unpredictable in the one place predictability matters: you could not
tell by looking whether a keyword would fire.

So the trade is explicit. Every keyword fires, every time, and the escape hatch is the thing that
has to be flawless. Under the hood BunnyLol tags its own searches with a `blpass=1` parameter and
registers a top-priority `allow` rule for anything carrying it. Without that tag an escaped search
would land on `google.com/search?q=gh+foo`, which is exactly the URL the redirect rule was built to
catch, and you would bounce back into the shortcut you were escaping. The same tag is why the
commands that *are* searches — `g`, `ddg` — reach the engine once instead of looping through the
dispatch page. If you see that parameter in an address bar, it is BunnyLol's, and it is inert.

### Exempting a keyword you keep tripping over

If one keyword annoys you in practice — "I search for *maps of X* constantly" — exempt it. Settings
has an **Address-bar interception** card: type the keyword, press Add, and it is skipped in the
address bar from then on. Remove the chip to get interception back.

An exemption costs the keyword nothing but address-bar interception. It keeps resolving through `bl`
+ Tab and the toolbar popup, where you have already said you mean a command. Nothing ships exempted.

### Seeing which command fired

Off by default, at the foot of the **Search interception** card: **Confirm before opening a
shortcut** shows a small toast on the dispatch page — `gh → github.com · search instead` — with a
link that runs the escaped search instead, and a `×` to go through immediately.

It is opt-in because it genuinely delays the navigation by about 1.2 seconds. Nothing rendered on
the dispatch page survives the redirect, so showing the toast *on the destination* would need a
content script injected into every site you visit, which is not a permission this feature justifies.
Turn it on while you are learning the keywords, then turn it off.

## What ships

A bare keyword goes to the site's home; adding arguments does the smart thing.

| Type this | You get |
|---|---|
| `gh facebook/react` | `github.com/facebook/react` — the repo itself, not a search |
| `gh` | GitHub home |
| `c explain monads` | Claude with the prompt already filled in (`gpt` for ChatGPT, `gem` for Gemini) |
| `? explain monads` | The same prompt, sent to whichever AI you set as the default (popup or `bl` + Tab — `?` is not an address-bar-safe alias) |
| `rd rust` | `reddit.com/r/rust` |
| `npm zod` | The `zod` package page, skipping npm's search results |
| `td groceries` | Searches your Todoist tasks; `tda groceries` is the one that creates one |
| `zoom 1234567890` | Joins that meeting; `zoom h6 recorder review` searches instead of building a dead join link |
| `ups 1Z…` | Tracks that parcel; anything that is not a tracking number searches |
| `def ineffable` | The dictionary entry |
| `\gh` *anything* | Escape hatch: a leading `\` (or `=`) forces a plain search instead of a shortcut |

Four of those rows are not in the starter set: `rd` is in the **Social** pack, and `td`, `tda`,
`zoom` and `ups` are in **Productivity**. Both packs start switched off — tick them on the welcome
screen, or reopen it later from **Settings → Sections → Shortcut packs**. Everything else in the
table ships on.

The full list — every alias, grouped, with a worked example per row — is in the options page. Use
the filter box there rather than memorising it.

## Managing shortcuts

Open the options page from the popup, from `set` in the address bar, or by right-clicking the
toolbar icon → **Options**.

- **Shortcuts** lists everything, grouped, with a live filter (press `/`). Groups collapse; the
  state is remembered per browser profile, and typing in the filter expands them until you clear
  it. **Collapse all** / **Expand all** are in the panel head.
- **Every shortcut is editable, whether it ships with BunnyLol or you made it.** A row's actions are
  Edit and Delete — as icons, labelled on hover — followed by the on/off switch, and they mean the
  same thing on both. The form takes keys, name, description, URL, an optional search URL
  containing `{q}`, a section and an example, and a live preview shows where a sample query would
  actually land as you type. Duplicate keys, malformed URLs and a missing `{q}` are flagged before
  you can save.
- **Reset**, in the form, refills the inputs: with the shipped definition for a shipped shortcut,
  with the values you last saved for one of your own. It does not touch the on/off switch or save
  anything by itself — Save does.
- **Shipped shortcuts are never mutated.** An edit is stored as a diff against the shipped
  definition, so a corrected URL in a later build still reaches you if all you did was rename the
  command. Edited rows carry a *modified* badge.
- **Deleting a shipped shortcut is reversible.** Settings → **Restore shipped shortcuts** lists
  everything you deleted; restoring brings back its shipped definition along with anything you had
  edited.

### Sections

Sections are the groups in the list. Any shortcut can go in any section, including the ones that
ship — renaming *Developer* renames the heading everywhere.

Create one from **Settings → Sections**, or from the **New section…** row in the form's section
menu, which files the shortcut you are editing straight into it. Deleting a section does not delete
its shortcuts: they move to **My shortcuts**, which is where new ones start.

### Import, export and packs

**Settings → Data** exports your whole customisation layer plus settings to one JSON file and reads
it back. That is how you move shortcuts between browsers and profiles — each one has its own
extension storage, and nothing is synced through an account.

Importing asks first, and the dialog spells out what each choice does before anything is written:

- **Merge** adds the file's shortcuts to the ones you have. Yours win every collision — an incoming
  alias that is already taken is renamed (`gh` → `gh2`) rather than overwriting yours, and shortcuts
  identical to ones you have are skipped. Your settings are left alone.
- **Replace everything** deletes your shortcuts and installs only what is in the file. If the file
  carries settings, yours are replaced too; if it does not, yours stay.

The dialog itemises what will happen before you commit — what comes in, which keywords get renamed,
which shipped shortcuts the file turns off or edits — and **Cancel** writes nothing. Either way a
timestamped backup of your current state is downloaded first, so "undo" is a file in your Downloads
folder. Files written by older versions still import.

A **pack** is just an import file someone else prepared. [`extras/packs/`](extras/packs/) holds the
ones this repo ships — including `removed-commands.json`, the shortcuts that used to ship —
and [its README](extras/packs/README.md) documents the format if you want to write one.

**Reset to defaults**, in the same card, deletes every shortcut you made, restores every shipped one
you turned off or deleted, forgets your sections and puts settings back.

### Settings

| Card | What is in it |
|---|---|
| **Defaults** | Your GitHub username (used by `gh me`, `pr`, `iss`), where an unmatched query goes (any template with `{q}` — Kagi and Brave Search are one click, or paste your own), which AI the `?` shortcut routes to, and your Google account index for `/u/N/` URLs |
| **Sections** | Create, rename and delete sections; the link back to the shortcut-packs screen |
| **Restore shipped shortcuts** | Anything shipped that you deleted |
| **Search interception** | Which engines are intercepted (unchecking all of them leaves every search alone), the dispatch-page URL to paste in as a custom search engine, and **Confirm before opening a shortcut** |
| **Address-bar interception** | The exemption list |
| **AI prompt templates** | The `?q=` prefill URL for each AI provider. These parameters are undocumented and providers change them, so they are editable without a rebuild |
| **Data** | Export, import, reset |

### Rule status

A pill in the options page header reports what the redirect rules are *actually* doing, read back
from Chrome rather than from what BunnyLol asked for.

| Pill | Colour | Meaning |
|---|---|---|
| *Shortcuts active* | green | Every eligible alias is intercepted on every engine you selected, with nothing dropped. |
| *…N exempted by you* | green | Your choice, not a failure — those still work from `bl` + Tab and the popup. |
| *Some keywords not intercepted* + a detail line | amber | Partial coverage: the rules are live, but some aliases ended up without one because Chrome refused to compile their pattern or the rule budget filled up. The detail says which. They fall through to a normal search in the address bar. |
| *Interception off* | amber | No engines selected, so nothing is intercepted, by design. |
| *Rules not registered* | red | The sync itself failed and nothing is intercepted; the detail carries the error. Click **Re-sync**. |

The two failure colours are two different fields: red is a sync error, amber is a warning from a
sync that worked.

## Troubleshooting

| Symptom | What is going on |
|---|---|
| **A keyword typed in the address bar just searches for it.** | The redirect rules are not registered. Check the rule-status pill and click **Re-sync**. The rules embed the extension's ID, so loading `dist/` from a new path changes the ID and needs a re-sync. Use `bl` + Tab meanwhile. |
| **Nothing happens, or the dispatch page shows an error.** | Open `chrome://extensions`, find BunnyLol and click **service worker** for its console. Rule-sync failures, storage errors and omnibox activity are logged there; the dispatch page prints the reason it could not resolve rather than hanging. |
| **An AI shortcut opens the site but does not carry my prompt.** | Those prefill parameters change without notice. No rebuild needed: edit the provider's template in **Settings → AI prompt templates** (it must contain `{q}`). |
| **A shortcut collides with something I actually search for.** | By design — the first word is always a command. Prefix with `\` or `=`. If it happens constantly with one keyword, exempt it in **Address-bar interception**, or rename, switch off or delete the shortcut. |
| **`g wagon price` searched for "wagon price".** | Working as intended: `g` is the "search Google" command and its argument is what gets searched. Use `\g wagon price` for the literal phrase. |
| **One shortcut only works from the popup or `bl` + Tab.** | Either you exempted it, or its alias cannot be embedded in a URL pattern (interception needs lowercase ASCII letters, digits, `_` and `-`, starting with a letter, digit or `_`, and at most 32 characters), or the pill reports it as dropped because Chrome refused the pattern or the rule budget is full. All three leave it working everywhere else. |
| **A shipped shortcut points at the wrong place for me.** | Edit it. The Purdue shortcuts in particular derive their host from the URL on the row, so rebinding one to your own institution works. |

## Development

```bash
pnpm dev         # vite build --watch
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # icons + typecheck + vite build -> dist/
pnpm package     # build, then release/bunnylol-<version>.zip for the Web Store
```

The resolver (`src/lib/resolve.ts`) is pure and free of `chrome.*`, so the dispatch page, the
omnibox, the popup and the tests all share one code path.

The UI's colours, type scale and spacing come from one token set, [`design/`](design/), which also
holds the HTML previews the design was approved from. The pages ship the [Inter](docs/fonts.md)
variable font as a bundled file rather than a webfont request, so rendering the extension's own
pages needs no network.

[CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the checks a change has to pass and how to add
a command. [AGENTS.md](AGENTS.md) is the architecture note — read its invariants before changing
routing or validation; every one of them is a bug that already shipped once.

## Privacy

No collection, no transmission, no analytics, no telemetry, no remote code, no network requests of
its own. Everything is one JSON value in `chrome.storage.local` on your device. Full statement:
[PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE). The bundled Inter font is licensed separately under the SIL Open Font License 1.1;
see [docs/fonts.md](docs/fonts.md).
