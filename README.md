# BunnyLol

BunnyLol turns the Chrome address bar into a command line. Type a keyword and its arguments, and you
land on the page itself, not on a results page:

```
gh facebook/react   →   github.com/facebook/react
npm zod             →   npmjs.com/package/zod
c explain monads    →   Claude, with the prompt already in the box
```

This is an independent, unofficial project. It is inspired by the bunnylol-style command bar used
inside Meta. **Not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc.**

Manifest V3. No dependencies at runtime. It makes no network requests of its own, and nothing leaves
your machine. See [PRIVACY.md](PRIVACY.md).

## Install from source

There is no store listing yet. Build it and load it unpacked:

```bash
pnpm install
pnpm build
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repo's `dist/` folder.

After you pull, run `pnpm build` again, then press the reload arrow on the extension card. Editing
source does not update a loaded extension.

**Chrome 123 or newer.** The UI declares its colours with CSS `light-dark()`, which Chrome added in
123. On anything older, every themed colour falls back to `unset` and the pages are unreadable.
`minimum_chrome_version` in the manifest records the same floor. Other Chromium browsers work the
same way: the MV3 manifest, the service worker and the redirect rules all behave identically. But a
fork that routes the omnibox itself may not hand over address-bar navigations. There the toolbar
popup and `bl` + Tab still work.

## First run

The first install opens a **welcome screen**. It asks one question: which packs of shipped shortcuts
do you want? Only **Search**, **Developer** and **AI** are ticked. Every other pack is offered
unticked, and its shortcuts start switched off: **Google**, **Microsoft**, **Social**,
**Productivity**, and, under *Optional packs*, **Purdue**. Purdue is one university's tooling, dead
weight for everyone else. You can close the tab without answering and keep that starter set. The
pick is written before the screen opens, so it is already live.

Nothing there is final. You can rename, move, switch off or delete every shortcut afterwards. To
reopen the screen, go to **Settings → Sections → Shortcut packs → Choose shortcut packs…**. That is
how you turn a pack on later. Note what Continue means when you do. It turns *on* every shipped
shortcut in the packs you tick, including ones you had switched off by hand. It turns off the ones
in the packs you leave unticked. It never touches shortcuts you made yourself.

## How triggering works

**The first word wins.** If the first word you type in the address bar is a keyword you have, it is
a command. Always, with no heuristics. `c programming tutorial` opens Claude with that prompt. `pr
firms in new york` opens your GitHub pull requests. `map of france` opens Google Maps. That is the
contract, and it is what makes the address bar predictable. You never wonder whether a keyword will
fire this time.

The other half is how to say *no, actually search for that*. It takes one keystroke:

| Type this | You get |
|---|---|
| `\gh foo` | A plain search for **gh foo**. A leading backslash escapes the whole query. |
| `=gh foo` | Identical. `=` is the same escape, one unshifted key on every layout. |
| `g wagon price` | A Google search for **wagon price**. `g` is the "search Google" command, and its argument is what gets searched. |
| `ddg …` | The same, on DuckDuckGo. |

Note the difference between the first two rows and the third. To search for the literal phrase **g
wagon price**, escape it: `\g wagon price`. Do the same for `pr` (`\pr firms in new york`) and
anything else. The escape character is stripped before the search, so it never reaches the engine as
a search term. It works on every surface, because they all run the same resolver.

### The three ways in

Google stays your real default search engine. Nothing about your browser settings changes.

- **Address bar (primary).** A `declarativeNetRequest` rule matches search URLs whose query starts
  with a keyword you have. It redirects them to the extension's local dispatch page before any
  request leaves your machine. That page resolves the keyword and replaces itself with the
  destination:

  ```
  google.com/search?q=gh+facebook/react   →   go.html?q=gh facebook/react   →   github.com/facebook/react
  ```

  A separate rule with higher priority matches a query that *starts* with an escape character. It
  covers both the raw and the percent-encoded form, because Chrome sends `\` to the engine as `%5C`.
  So `\gh foo` is intercepted too, and turned into a clean search for "gh foo". The rules are
  rebuilt from your live keyword list whenever you change a shortcut. An ordinary search like `how
  tall is the eiffel tower` never matches and is not slowed down. Bing and DuckDuckGo are
  intercepted the same way, and you can switch off each engine in Settings.

- **Omnibox keyword (fallback).** Type `bl`, press **Tab**, then your command. This path does not
  use the redirect rules at all. So it is the safety net if interception behaves differently in your
  browser, and it is where an exempted keyword (below) still works.

- **Toolbar popup.** Click the BunnyLol icon for a command bar with autocomplete over the same
  registry. Handy when you are already on a page.

All of them run the same resolver, so a shortcut behaves the same no matter how you invoke it.

### Why an escape hatch and not a list of "safe" words

BunnyLol used to ship a stop list. Keywords like `map`, `news`, `mail` and `so` were left out of
address-bar interception, because they were plausible first words of ordinary searches. That list is
gone and the default is empty.

It was an endless tail. A large fraction of the keywords that stayed eligible could still hijack
some plausible English query, and blocking those only surfaced the next tier: `td`, `iss`, `bs`,
`gs`. Worse, it made behaviour unpredictable in the one place where predictability matters. You
could not tell by looking whether a keyword would fire.

So the trade is explicit. Every keyword fires, every time, and the escape hatch has to be flawless.
Under the hood, BunnyLol tags its own searches with a `blpass=1` parameter, and registers a
top-priority `allow` rule for anything carrying that tag. Without the tag, an escaped search would
land on `google.com/search?q=gh+foo`. That is exactly the URL the redirect rule was built to catch,
so you would bounce back into the shortcut you were escaping. The same tag is why the commands that
*are* searches, `g` and `ddg`, reach the engine once instead of looping through the dispatch page.
If you see that parameter in an address bar, it is BunnyLol's, and it does nothing.

### Exempting a keyword you keep tripping over

Say one keyword annoys you in practice: "I search for *maps of X* constantly." Exempt it. Settings
has an **Address-bar interception** card. Type the keyword, press Add, and the address bar skips it
from then on. Remove the chip to get interception back.

An exemption costs the keyword nothing but address-bar interception. It still resolves through `bl`
+ Tab and the toolbar popup, where you have already said you mean a command. Nothing ships exempted.

### Seeing which command fired

**Confirm before opening a shortcut** sits at the foot of the **Search interception** card, and is
off by default. It shows a small toast on the dispatch page: `gh → github.com · search instead`. The
link runs the escaped search instead, and the `×` goes through immediately.

It is opt-in because it really does delay the navigation by about 1.2 seconds. Nothing rendered on
the dispatch page survives the redirect. Showing the toast *on the destination* would need a content
script injected into every site you visit, and this feature does not justify that permission. Turn
it on while you are learning the keywords, then turn it off.

## What ships

A bare keyword goes to the site's home page. Adding arguments does the smart thing.

| Type this | You get |
|---|---|
| `gh facebook/react` | `github.com/facebook/react`, the repo itself, not a search |
| `gh` | GitHub home |
| `c explain monads` | Claude with the prompt already filled in (`gpt` for ChatGPT, `gem` for Gemini) |
| `? explain monads` | The same prompt, sent to whichever AI you set as the default. Popup or `bl` + Tab only, because `?` is not an address-bar-safe alias |
| `rd rust` | `reddit.com/r/rust` |
| `npm zod` | The `zod` package page, skipping npm's search results |
| `td groceries` | Searches your Todoist tasks; `tda groceries` is the one that creates one |
| `zoom 1234567890` | Joins that meeting; `zoom h6 recorder review` searches instead of building a dead join link |
| `ups 1Z…` | Tracks that parcel; anything that is not a tracking number searches |
| `track 9400…` | Reads the carrier off the number (UPS, USPS, FedEx or DHL) and opens its tracking page |
| `def ineffable` | The dictionary entry |
| `\gh` *anything* | Escape hatch: a leading `\` (or `=`) forces a plain search instead of a shortcut |

Some of those rows are not in the starter set. `rd` is in the **Social** pack, and `td`, `tda`,
`zoom`, `ups` and `track` are in **Productivity**. Both packs start switched off. Tick them on the
welcome screen, or reopen it later from **Settings → Sections → Shortcut packs**. Everything else in
the table ships on.

The options page has the full list: every alias, grouped, with a worked example per row. Use the
filter box there rather than memorising it.

## Managing shortcuts

Open the options page from the popup, from `set` in the address bar, or by right-clicking the
toolbar icon → **Options**.

- **Shortcuts** lists everything, grouped, with a live filter (press `/`). Groups collapse, and each
  browser profile remembers its own state. Typing in the filter expands them until you clear it.
  **Collapse all** and **Expand all** are in the panel head.
- **Every shortcut is editable, whether it ships with BunnyLol or you made it.** A row's actions are
  Edit and Delete, as icons labelled on hover, followed by the on/off switch. They mean the same
  thing on both kinds. The form takes keys, name, description, URL, an optional search URL
  containing `{q}`, a section and an example. A live preview shows where a sample query would
  actually land as you type. Duplicate keys, malformed URLs and a missing `{q}` are flagged before
  you can save.
- **Reset**, in the form, refills the inputs. For a shipped shortcut it uses the shipped definition.
  For one of your own it uses the values you last saved. It does not touch the on/off switch, and it
  saves nothing by itself. Save does that.
- **Shipped shortcuts are never mutated.** An edit is stored as a diff against the shipped
  definition. So if all you did was rename the command, a corrected URL in a later build still
  reaches you. Edited rows carry a *modified* badge.
- **Deleting a shipped shortcut is reversible.** Settings → **Restore shipped shortcuts** lists
  everything you deleted. Restoring brings back its shipped definition, along with anything you had
  edited.

### Sections

Sections are the groups in the list. Any shortcut can go in any section, including the ones that
ship. Renaming *Developer* renames the heading everywhere.

Create a section from **Settings → Sections**, or from the **New section…** row in the form's
section menu. That row files the shortcut you are editing straight into it. Deleting a section does
not delete its shortcuts. They move to **My shortcuts**, which is where new ones start.

### Import, export and packs

**Settings → Data** exports your whole customisation layer plus your settings to one JSON file, and
reads it back. That is how you move shortcuts between browsers and profiles. Each one has its own
extension storage, and nothing is synced through an account.

Importing asks first. The dialog spells out what each choice does before anything is written:

- **Merge** adds the file's shortcuts to the ones you have. Yours win every collision. An incoming
  alias that is already taken is renamed (`gh` → `gh2`) rather than overwriting yours, and shortcuts
  identical to ones you have are skipped. Your settings are left alone.
- **Replace everything** deletes your shortcuts and installs only what is in the file. If the file
  carries settings, yours are replaced too. If it does not, yours stay.

The dialog itemises what will happen before you commit: what comes in, which keywords get renamed,
and which shipped shortcuts the file turns off or edits. **Cancel** writes nothing. Either way, a
timestamped backup of your current state is downloaded first, so "undo" is a file in your Downloads
folder. Files written by older versions still import.

A **pack** is just an import file someone else prepared. [`extras/packs/`](extras/packs/) holds the
ones this repo ships, including `removed-commands.json`, the shortcuts that used to ship. [Its
README](extras/packs/README.md) documents the format if you want to write one.

**Reset to defaults**, in the same card, deletes every shortcut you made. It restores every shipped
one you turned off or deleted, forgets your sections, and puts settings back.

### Settings

| Card | What is in it |
|---|---|
| **Defaults** | Your GitHub username (used by `gh me`, `pr`, `iss`); where an unmatched query goes (any template with `{q}`, with Kagi and Brave Search one click away, or paste your own); which AI the `?` shortcut routes to; and your Google account index for `/u/N/` URLs |
| **Sections** | Create, rename and delete sections; the link back to the shortcut-packs screen |
| **Restore shipped shortcuts** | Anything shipped that you deleted |
| **Search interception** | Which engines are intercepted (untick them all to leave every search alone), the dispatch-page URL to paste in as a custom search engine, and **Confirm before opening a shortcut** |
| **Address-bar interception** | The exemption list |
| **AI prompt templates** | The `?q=` prefill URL for each AI provider. These parameters are undocumented and providers change them, so they are editable without a rebuild |
| **Data** | Export, import, reset |

### Rule status

A pill in the options page header reports what the redirect rules are *actually* doing. It reads
that back from Chrome, not from what BunnyLol asked for.

| Pill | Colour | Meaning |
|---|---|---|
| *Shortcuts active* | green | Every eligible alias is intercepted on every engine you selected, with nothing dropped. |
| *…N exempted by you* | green | Your choice, not a failure. Those still work from `bl` + Tab and the popup. |
| *Some keywords not intercepted* + a detail line | amber | Partial coverage. The rules are live, but some aliases ended up without one, because Chrome refused to compile their pattern or the rule budget filled up. The detail says which. In the address bar they fall through to a normal search. |
| *Interception off* | amber | No engines selected, so nothing is intercepted. That is by design. |
| *Rules not registered* | red | The sync itself failed and nothing is intercepted. The detail carries the error. Click **Re-sync**. |

Red and amber are two different fields. Red is a sync error. Amber is a warning from a sync that
worked.

## Troubleshooting

| Symptom | What is going on |
|---|---|
| **A keyword typed in the address bar just searches for it.** | The redirect rules are not registered. Check the rule-status pill and click **Re-sync**. The rules embed the extension's ID, so loading `dist/` from a new path changes the ID and needs a re-sync. Use `bl` + Tab meanwhile. |
| **Nothing happens, or the dispatch page shows an error.** | Open `chrome://extensions`, find BunnyLol and click **service worker** for its console. Rule-sync failures, storage errors and omnibox activity are logged there. The dispatch page prints the reason it could not resolve rather than hanging. |
| **An AI shortcut opens the site but does not carry my prompt.** | Those prefill parameters change without notice. You do not need a rebuild: edit the provider's template in **Settings → AI prompt templates** (it must contain `{q}`). |
| **A shortcut collides with something I actually search for.** | That is by design: the first word is always a command. Prefix it with `\` or `=`. If it happens constantly with one keyword, exempt it in **Address-bar interception**, or rename, switch off or delete the shortcut. |
| **`g wagon price` searched for "wagon price".** | Working as intended. `g` is the "search Google" command, and its argument is what gets searched. Use `\g wagon price` for the literal phrase. |
| **One shortcut only works from the popup or `bl` + Tab.** | Either you exempted it, or its alias cannot be embedded in a URL pattern, or the pill reports it as dropped because Chrome refused the pattern or the rule budget is full. Interception needs lowercase ASCII letters, digits, `_` and `-`, starting with a letter, digit or `_`, and at most 32 characters. All three cases leave the shortcut working everywhere else. |
| **A shipped shortcut points at the wrong place for me.** | Edit it. The Purdue shortcuts in particular read their host off the URL on the row, so rebinding one to your own institution works. |

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

The UI's colours, type scale and spacing come from one token set, [`design/`](design/). That folder
also holds the HTML previews the design was approved from. The pages ship the
[Inter](docs/fonts.md) variable font as a bundled file rather than a webfont request, so rendering
the extension's own pages needs no network.

[CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the checks a change has to pass, and how to add
a command. [AGENTS.md](AGENTS.md) is the architecture note. Read its invariants before you change
routing or validation: every one of them is a bug that already shipped once.

## Privacy

No collection, no transmission, no analytics, no telemetry, no remote code, and no network requests
of its own. Everything is one JSON value in `chrome.storage.local` on your device. Full statement:
[PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE). The bundled Inter font is licensed separately under the SIL Open Font License 1.1.
See [docs/fonts.md](docs/fonts.md).
