# Packs

A pack is a JSON file in the same shape the options page's Import accepts:
`{ "overrides": { "custom": [ ... ] } }`. Each object in `custom` is a
shortcut, in the same shape as `Command` in `src/lib/types.ts`.

A pack may also carry `"sections": [{ "id": …, "label": … }]`. A `category`
names either a section BunnyLol ships or one the same file declares. A pack
that groups its entries under a name of its own should bring that group with
it: an id that names neither is not an error, but its shortcuts land in **My
shortcuts** instead of the group the author chose.

## `removed-commands.json`

Commands that used to ship as builtins and were pruned from the default
registry — kept here, verbatim field-for-field, so they can be restored.

It declares one section, `media`: that was a shipped category until v1.1.0,
when categories became open section ids and the shipped one — by then empty —
was removed. Declaring it is what keeps these entries in a group called Media
instead of in My shortcuts; nothing forces a pack to, and a v1.0.0 export that
names `media` and declares nothing still imports.

To use one: open the options page, go to the **Data** card, choose
**Import**, pick this file, and import as a **Merge**. They come in as your
own shortcuts, not builtins — editing or deleting one never affects anyone
else's install.

Some entries carry a `_note` field. It is not read by the importer (only
`keys`, `name`, `description`, `url`, `searchUrl`, `category`, `example` and
`handler` are); it is there so a human opening the file can see why a command
was written the way it was, e.g. why `copilot` opens the app instead of
prefilling a query, or why `gss` points at Gradescope's own login page.

Note also that `aws`, `gcp`, `vercel`, `netlify` and `cf` lost their Google
`site:` doc search when they were pruned down to pure jumps — that change
happened in the live registry, not in this pack, so it isn't recorded here.

If an entry names a `handler` this build doesn't have (this pack still
references a few ids — `gsite`, `localhost`, `pkg`, `telegram`, `ticker`,
`unindexed`, `wayback` — that predate the current `HandlerId` union),
`resolve()` skips the missing handler and falls back to the entry's
`searchUrl` if it has one, otherwise to its bare `url` — it never throws
(see `rawDestination` in `src/lib/resolve.ts`). Entries with a `searchUrl`
keep plain `{q}` substitution; the rest drop their arguments.

## Promoting a pack entry to a builtin

Paste the object into `BUILTIN_COMMANDS` in `src/lib/commands.ts`, drop the
`_note` field (or fold it into a code comment, which is where it came from),
and set `builtin: true`. If it names a `handler`, that `HandlerId` and its
implementation need to exist in `src/lib/handlers.ts` — restore it from git
history if it doesn't.
