# BunnyLol

BunnyLol is a Chrome (Manifest V3) extension that turns your address bar into a command line: type a
short keyword plus arguments and land on the exact page instead of a search results page. It is a
personal clone of Meta's internal BunnyLol — `gh facebook/react` goes straight to the repo, and
anything that isn't a registered keyword falls through to a normal Google search.

## Install

```bash
pnpm install
pnpm build
```

Then load the built extension:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder in this repo.

**Chrome 123 or newer.** The UI's colour tokens are declared with CSS `light-dark()`, which
Chrome added in 123; on anything older every themed colour falls back to `unset` and the pages are
unreadable. `minimum_chrome_version` in the manifest records the same floor.

Works the same in **Brave** (`brave://extensions`) and **Dia** — both are Chromium, so the MV3
manifest, the service worker and the redirect rules behave identically. Rebuild with `pnpm build`
after pulling changes, then hit the reload arrow on the extension card.

## How triggering works

**The first word wins.** If the first word of what you type in the address bar is a keyword you have
registered, it is a command — always, no exceptions, no heuristics. `c programming tutorial` opens
Claude with that prompt. `pr firms in new york` opens your GitHub pull requests. `maps of the world`
opens Google Maps. That is not a bug; it is the same contract Meta's internal bunnylol has, and it is
what makes the address bar predictable: you never have to wonder whether a keyword will fire this
time.

The habit you have to learn is the other half of it — **how to say "no, actually search for that"**.
There are four ways, and all of them are one keystroke:

| Type this | You get |
|---|---|
| `\gh foo` | A plain search for **gh foo**. A leading backslash escapes the whole query. |
| `=gh foo` | Identical. `=` is the same escape, one unshifted key on every layout. |
| `g wagon price` | A Google search for **wagon price** — the `g` is the command and is consumed. |
| `ddg …` / `bing …` | The same, on DuckDuckGo or Bing. |

Note the difference between the last two rows and the first two. `g wagon price` searches for
"wagon price", *not* for "g wagon price" — the leading `g` is eaten by design, because `g` is the
"search Google" command. To search for the literal phrase **g wagon price**, escape it:
`\g wagon price` or `=g wagon price`. Same for `pr` (`\pr firms in new york`) and anything else.

The escape works everywhere the resolver runs: the address bar, `bl` + Tab, and the popup. The
escape character is stripped before the search — it never reaches Google as a search term.

### The three ways in

Google stays your real default search engine — nothing about your browser settings changes.

- **Address bar (primary).** A `declarativeNetRequest` rule matches search URLs whose query starts
  with a keyword you have registered, and redirects them to the extension's local dispatch page
  before any network request leaves your machine. That page resolves the keyword and replaces itself
  with the destination:

  ```
  google.com/search?q=gh+facebook/react   →   go.html?q=gh facebook/react   →   github.com/facebook/react
  ```

  A separate, higher-priority rule matches a query that *starts* with an escape character — in both
  its raw and percent-encoded forms, because Chrome sends `\` to the engine as `%5C` — so
  `\gh foo` is intercepted too, and turned into a clean search for "gh foo". Rules are regenerated
  from your live keyword list every time you change a shortcut, so an ordinary search like
  `how tall is the eiffel tower` never matches and is not slowed down by a millisecond. Bing and
  DuckDuckGo are intercepted the same way; you can turn individual engines off in the options page.

- **Omnibox keyword (fallback).** Type `bl`, press **Tab**, then your command. This path does not
  depend on redirect rules at all, so it is the safety net if interception behaves differently in
  your browser — and it is where an exempted keyword (below) still works.

- **Toolbar popup.** Click the BunnyLol icon for a command bar with fuzzy autocomplete over the same
  registry — handy when you are already on a page.

All three routes run the same resolver, so a shortcut behaves identically no matter how you invoke it.

### Why escaping, and not a list of "safe" words

BunnyLol used to ship a stop list: about forty keywords (`map`, `news`, `mail`, `so`, `new`, `help`,
`r`, …) left out of address-bar interception because they were plausible first words of ordinary
searches. That list is gone, and the default is now empty.

It was an endless tail. Roughly 111 of the 271 keywords that remained eligible could still hijack
some plausible English query, and blocking those would only have surfaced the next tier — `td`,
`iss`, `bs`, `gs`. Worse, the list made behaviour unpredictable in the one place predictability
matters: you could not tell by looking whether a keyword would fire.

So the trade is explicit now. Every keyword fires, every time, and the escape hatch is the thing that
has to be flawless rather than the blocklist. Under the hood BunnyLol tags its own searches with a
`blpass=1` parameter and registers a top-priority `allow` rule for anything carrying it. Without that
tag the escaped search would land on `google.com/search?q=gh+foo`, which is exactly the URL the
redirect rule was built to catch, and you would bounce straight back into the shortcut you were
escaping. The same tag is why commands that *are* searches — `weather`, `g`, `gimg`, `gsite` — reach
Google once instead of looping through the dispatch page. If you ever see that parameter in an
address bar, it is BunnyLol's, and it is inert.

### Exempting a keyword you keep tripping over

If one specific keyword annoys you in practice — "I search for *maps of X* constantly" — exempt it.
The options page has an **Address-bar interception** card: type the keyword, press Add, and it is
skipped in the address bar from then on. Remove the chip to get interception back, or use
**Intercept everything** to clear the list.

An exemption costs the keyword nothing but address-bar interception. It keeps resolving through `bl`
+ Tab and the toolbar popup, where you have already said you mean a command. Nothing ships exempted:
the list starts empty and stays empty until you put something in it.

### Seeing which command fired

Off by default, in the same options card: **Confirm before opening a shortcut** shows a small toast
on the dispatch page — `gh → github.com · search instead` — with a link that runs the escaped search
instead, and a `×` to go through immediately.

It is opt-in because it genuinely delays the navigation by about 1.2 seconds. Nothing rendered on the
dispatch page survives the redirect, so the only way to show the toast *on the destination* would be
a content script injected into every site you visit, which is not a permission this feature
justifies. Turn it on while you are learning the keywords, then turn it off.

## Commands

Bare keyword goes to the site's home; adding arguments does the smart thing.

| Type this | You get |
|---|---|
| `gh facebook/react` | `github.com/facebook/react` — the repo itself, not a search |
| `gh` | GitHub home |
| `c explain monads` | Claude with the prompt already filled in (`gpt` for ChatGPT, `gem` for Gemini) |
| `? explain monads` | Same prompt, sent to whichever AI you set as the default (popup or `bl` + Tab — `?` is not an address-bar-safe alias) |
| `rd rust` | `reddit.com/r/rust` |
| `npm zod` | The `zod` package page, skipping npm's search results |
| `lh 3000` | `localhost:3000` (`lh surge meaning` is a search — only a port or a path goes to your machine) |
| `td groceries` | Searches your Todoist tasks; `tda groceries` is the one that creates one |
| `zoom 1234567890` | Joins that meeting; `zoom h6 recorder review` searches instead of building a dead join link |
| `gsite react.dev hooks` | A `site:react.dev hooks` search |
| `gs` | Gradescope |
| `bs` | Brightspace |
| `outlook` | Outlook mail |
| `teams` | Microsoft Teams |
| `\gh` *anything* | Escape hatch: a leading `\` (or `=`) forces a plain search instead of a shortcut |

The full list — every alias, grouped by category, with a worked example per row — lives in the
options page; use the filter box there rather than memorizing it.

## Managing shortcuts

Open the options page from the popup, or right-click the toolbar icon → **Options**.

- **Browse** every command by category with a live filter.
- **Add or edit** a shortcut: aliases, name, URL, an optional search URL containing `{q}`, and a
  category. A **live preview** shows exactly where a sample query would land as you type, and
  duplicate keys, malformed URLs and a missing `{q}` are flagged immediately.
- **Built-ins are never mutated.** Disabling one or rebinding its keys is stored as an overrides
  layer, so updating the extension can't clobber your edits.
- **Import / export JSON.** Export writes your whole customization layer plus settings to one file;
  import reads it back. This is how you move your shortcuts between Chrome, Brave and Dia — each
  browser has its own extension storage.

  Importing asks first, and the dialog spells out what each choice does before anything is written:

  - **Merge** adds the file's shortcuts to the ones you already have. Yours win every collision — an
    incoming alias that is already taken is renamed (`gh` → `gh2`) rather than overwriting yours, and
    shortcuts identical to ones you have are skipped. Your settings are left alone.
  - **Replace everything** deletes your shortcuts and installs only what is in the file. If the file
    carries settings, yours are replaced too; if it doesn't, yours stay as they are.

  The dialog counts it out before you commit — how many shortcuts come in, which keywords get
  renamed, which built-ins the file turns off or rebinds — and **Cancel** writes nothing.

  Either way a timestamped backup of your current state is downloaded before anything is overwritten,
  so "undo" is a file in your Downloads folder.
- **Settings.** GitHub username (used by the GitHub shortcuts), the fallback search engine,
  which engines to intercept, the default AI, your Google account index for `/u/N/` URLs, the
  dispatch toast, and the address-bar exemption list.
- **Rule status.** A pill at the top of the options page reports what the redirect rules are actually
  doing, read back from Chrome rather than from what BunnyLol asked for:

  | Pill | Colour | Meaning |
  |---|---|---|
  | *Intercepting N keywords* | green | N aliases are intercepted on every engine you selected, with nothing dropped. |
  | *…N exempted by you* (**suppressed**) | green | Your choice, not a failure — those N still work from `bl` + Tab and the popup. Zero unless you exempted something. |
  | *Intercepting N keywords* + a detail line | amber | Partial coverage: the rules are live, but some eligible aliases ended up without one because Chrome refused to compile their pattern or the rule budget filled up (**dropped**). The detail says which. They fall through to a normal search in the address bar. |
  | *Interception off* | amber | You have no engines selected, so nothing is intercepted by design. |
  | *Rules not registered* | red | The sync itself failed and nothing is intercepted; the detail text carries the error. Click **Re-sync**. |

  The two failure colours are two different fields: red is a sync `error`, amber is a `warning` from
  a sync that worked. `suppressed` is deliberate and leaves the pill green; `dropped` turns it amber,
  because something you asked for is not happening.

  With nothing exempted the current registry registers **60 rules**
  — 54 keyword rules (18 shards × 3 engines), 3 passthrough allow rules and 3 escape rules — and
  intercepts all 317 aliases with none dropped.

## Troubleshooting

**A keyword typed in the address bar just searches Google for it.**
The redirect rules aren't registered. Open the options page and check the **rule status** indicator —
it reports how many rules are live and any error. Click re-sync. If it still reads zero, confirm the
extension has host permission for the engine you're searching from, and use `bl` + Tab in the
meantime. Note that the rules embed the extension's ID: if you loaded `dist/` from a new path, the ID
changed and a re-sync is required.

**Nothing happens, or the dispatch page shows an error.**
Go to `chrome://extensions`, find BunnyLol, and click the **service worker** link to open its
console. Rule-sync failures, storage errors and omnibox activity are all logged there. The dispatch
page itself prints the reason it could not resolve a query instead of silently hanging.

**An AI shortcut opens the site but doesn't carry my prompt.**
The `?q=` prefill parameters these providers accept are undocumented and change without notice. You
do not need a rebuild: open the options page, find the AI provider, and edit its URL template (it
must contain `{q}`). The override is saved to storage and takes effect on the next query.

**A shortcut collides with something I actually search for.**
That is the design, not a fault: the first word is always a command. Prefix the query with `\` or
`=` — `\gs prices` and `=gs prices` both search for "gs prices" instead of opening Gradescope. If it
happens constantly with one keyword, exempt that keyword in the **Address-bar interception** card,
or rebind/disable the shortcut; the redirect rules are rebuilt from the new keyword list immediately.

**`g wagon price` searched for "wagon price".**
Working as intended. `g` is the "search Google" command and its argument is what gets searched. Use
`\g wagon price` or `=g wagon price` for the literal phrase.

**One specific shortcut only works from the popup or `bl` + Tab.**
Three things take a keyword out of the address bar, and all three leave it working everywhere else:

- You **exempted** it in the Address-bar interception card. Nothing is exempt out of the box, so this
  only happens if you put it there; delete the chip to get interception back.
- Its alias cannot be embedded in a URL pattern: interception needs lowercase ASCII letters, digits,
  `_` and `-`, starting with a letter, digit or `_`, and 32 characters or fewer. An alias with a `.`,
  `?`, `+` or a non-ASCII character is skipped. Rename it if you want it in the address bar.
- The rule status pill reports it as **dropped** — Chrome refused the pattern, or the rule budget is
  full. Disabling shortcuts you do not use frees budget.

**`outlook <search terms>` lands somewhere odd.**
Bare `outlook` opens your mailbox and is fine. The search form
(`outlook.office.com/mail/deeplink/search?query=…`) is the widely documented OWA route but is
**unverified against a live mailbox** — every unauthenticated request under `/mail/` answers 417, so
it cannot be probed from outside a signed-in tenant, and Microsoft may have retired it. If it does
not open your search results, use bare `outlook` and search in OWA, or rebind the shortcut to a plain
URL in the options page.

**`copilot <prompt>` does not reach Copilot.**
That is deliberate. Consumer Copilot has no working URL-prompt route: every `?q=` form, including
Microsoft's own `bing.com/search?showconv=1` entry point, 302s to the bare home page and drops the
prompt. Rather than guess a URL that silently loses what you typed, bare `copilot` opens the app and
`copilot <args>` runs a plain web search of what you typed. Use `c`, `gpt` or `?` for a prompt that
actually arrives prefilled.

## Development

```bash
pnpm dev        # vite build --watch
pnpm test       # vitest over the resolver, the handlers and the rule builder
pnpm typecheck  # tsc --noEmit
node scripts/gen-icons.mjs   # regenerate public/icons/*.png
```

The resolver (`src/lib/resolve.ts`) is pure and free of `chrome.*` calls, so the dispatch page, the
omnibox, the popup and the tests all share one code path.
