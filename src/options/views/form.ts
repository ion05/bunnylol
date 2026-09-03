/**
 * The "New shortcut" / "Edit" route: ONE form for every shortcut, shipped or
 * user-created, backed by `model/form.ts`'s pure validation and
 * `lib/draft.ts`'s command builder. There is no second editor and no "built in"
 * qualifier anywhere on this page: the whole point is that there is no
 * difference.
 *
 * The `textContent` rule `views/browse.ts` documents applies here too: this
 * view echoes the draft back in the live preview.
 */

import { BUILTIN_COMMANDS } from '../../lib/commands';
import type { Draft } from '../../lib/draft';
import {
  draftFrom,
  emptyDraft,
  parsePrefill,
  sameDraft,
  shippedDraftFor,
  splitKeys,
} from '../../lib/draft';
import {
  MAX_SECTIONS,
  addSection,
  diffEdit,
  knownCategoryIds,
  mintUserId,
  normalizeId,
  sectionLabel,
  sectionOptions,
  shortcutId,
} from '../../lib/overrides';
import { resolve, stripPassthrough } from '../../lib/resolve';
import { errorText } from '../../lib/text';
import type { Command, Overrides, ShortcutEdit } from '../../lib/types';
import { el } from '../../ui/dom';
import { button, errorField, field, selectControl, textInput } from '../dom';
import type { FieldSlot } from '../dom';
import { buildKeyOwner, browseEntries } from '../model/browse';
import type { Entry } from '../model/browse';
import type { FormContext, FormField, Problem } from '../model/form';
import {
  FORM_FIELDS,
  NEW_SECTION_VALUE,
  buildCommand,
  previewCommands,
  validateDraft,
} from '../model/form';
import { go } from '../router';
import {
  commitOverrides,
  getRoute,
  getSampleArgs,
  getState,
  setNotice,
  setSampleArgs,
} from '../store';

/** What the form is editing: nothing (`#new`), a shipped shortcut, or one of
 *  the user's own. `base` is the command an edit is an edit OF: the source of
 *  `handler`, `provider` and `builtin`, none of which the form shows. */
export interface FormTarget {
  id: string;
  shipped: boolean;
  base: Command | null;
}

const NO_TARGET: FormTarget = { id: '', shipped: false, base: null };

/**
 * `#edit?id=<id>`. `?key=` is accepted as well, for bookmarks written before
 * shortcuts had ids: that parameter carried a custom shortcut's id then and
 * reads as a keyword otherwise, so both passes run either way.
 *
 * Which pass runs FIRST is not cosmetic. `?key=gh` names whatever `gh` opens
 * now, and a user's own `gh` shadows the builtin (invariant 10), so the alias
 * pass leads there, and the id pass leads for `?id=`. `normalizeId` is the same
 * reader `mergeCommands` uses, so a hand-typed `?id=U:GH` finds its row.
 */
export function findEntry(entries: Entry[], params: URLSearchParams): Entry | undefined {
  const byId = (raw: string): Entry | undefined => {
    const id = normalizeId(raw);
    return id ? entries.find((entry) => entry.id === id) : undefined;
  };
  const byAlias = (raw: string): Entry | undefined => {
    const alias = raw.trim().toLowerCase();
    return alias
      ? entries.find((entry) => entry.cmd.keys.some((key) => key.trim().toLowerCase() === alias))
      : undefined;
  };

  const id = (params.get('id') ?? '').trim();
  if (id) return byId(id) ?? byAlias(id);
  const key = (params.get('key') ?? '').trim();
  if (key) return byAlias(key) ?? byId(key);
  return undefined;
}

export function renderForm(): HTMLElement {
  const route = getRoute();
  const entries = browseEntries(BUILTIN_COMMANDS, getState().overrides);
  const entry = route.name === 'edit' ? findEntry(entries, route.params) : undefined;
  // An `#edit` link to something that is not here any more, a deleted shipped
  // shortcut, a stale bookmark, used to render a blank New form, which offers
  // to create a shortcut nobody asked for under a heading that says Edit.
  if (route.name === 'edit' && !entry) {
    setNotice({
      tone: 'error',
      text: 'That shortcut is not here any more.',
    });
    go('#help');
    return el('section', { class: 'panel' });
  }
  const target: FormTarget = entry
    ? {
        id: entry.id,
        shipped: entry.shipped,
        // The SHIPPED definition for a shipped shortcut, not the merged one:
        // this is only ever read for the fields an edit may not touch, and the
        // merged copy carries them anyway.
        base: entry.shipped
          ? (BUILTIN_COMMANDS.find((cmd) => shortcutId(cmd) === entry.id) ?? null)
          : entry.cmd,
      }
    : NO_TARGET;

  const prefill = route.params.get('prefill') ?? '';
  /**
   * What Reset puts back: the shipped definition for a shipped shortcut, the
   * last-saved values for one of the user's own, the `add …` prefill for a new
   * one. `null` means there is nothing to go back TO, and the button is hidden.
   */
  const baseline: Draft | null = entry
    ? entry.shipped
      ? shippedDraftFor(entry.id, BUILTIN_COMMANDS)
      : draftFrom(entry.cmd)
    : prefill
      ? parsePrefill(prefill)
      : null;
  // The MERGED command, so editing a shipped shortcut starts from what it
  // currently does rather than from what the registry ships.
  const draft: Draft = entry ? draftFrom(entry.cmd) : (baseline ?? emptyDraft());

  const keysInput = textInput(draft.keys, 'gh, github', true);
  const nameInput = textInput(draft.name, 'GitHub');
  const descInput = textInput(draft.description, 'Open a repo, or search GitHub.');
  const urlInput = textInput(draft.url, 'https://github.com', true);
  const searchInput = textInput(draft.searchUrl, 'https://github.com/search?q={q}', true);
  const exampleInput = textInput(draft.example, 'gh facebook/react', true);

  const sections = getState().overrides.sections;
  // The sections that exist, not the shipped list: a shortcut filed under one
  // of the user's own sections must not be silently moved to whatever the
  // select happens to show first when they open the form.
  const options = sectionOptions(
    sections,
    entries.map((candidate) => candidate.cmd),
  ).map((section) => ({ value: section.id, label: section.label }));
  // A `<select>` cannot be set to a value it does not offer: it silently keeps
  // the first option, so a category no other shortcut is currently filed under
  // is added rather than dropped. Both the current one and the one Reset would
  // put back, because either can be the last member of its group.
  for (const id of [draft.category, baseline?.category ?? '']) {
    if (id && !options.some((option) => option.value === id)) {
      options.unshift({ value: id, label: sectionLabel(id, sections) });
    }
  }
  options.push({ value: NEW_SECTION_VALUE, label: 'New section…' });
  const categorySelect = selectControl(options, draft.category);

  const sectionInput = textInput('', 'Client work');
  const sectionRow = el('div', {
    class: 'section-new',
    children: [
      field(
        'New section name',
        sectionInput,
        'Becomes a group heading on this page. It is created when you save.',
        false,
        true,
      ),
    ],
  });
  sectionRow.hidden = true;

  const sampleInput = textInput(getSampleArgs(), 'arguments');
  sampleInput.setAttribute('aria-label', 'Sample arguments for the preview');
  const previewRows = el('div', { class: 'preview-rows' });
  const previewNote = el('p', { class: 'field-hint' });
  previewNote.hidden = true;

  const messages = el('div', { class: 'msg-list', attrs: { 'aria-live': 'polite' } });
  const saveButton = button('Save shortcut', () => void submit(), 'btn btn-primary');

  const inputs: Record<FormField, HTMLInputElement | HTMLSelectElement> = {
    keys: keysInput,
    url: urlInput,
    searchUrl: searchInput,
    category: categorySelect,
  };
  // Keywords and Destination URL are the two fields `validateDraft` (and
  // `buildCommand` beneath it) cannot proceed without: an empty keys list has
  // nothing to type in the address bar, and a bare keyword has to go
  // somewhere. Section always carries a value, the select cannot be left
  // blank, so it is not marked required even though a row is always filed
  // under one.
  const slots: Record<FormField, FieldSlot> = {
    keys: errorField('Keywords', keysInput, 'err-keys', undefined, false, true),
    url: errorField('Destination URL', urlInput, 'err-url', undefined, true, true),
    searchUrl: errorField(
      'Search URL',
      searchInput,
      'err-searchurl',
      'Put {q} where the arguments belong. Without it, BunnyLol appends ?q=…',
      true,
    ),
    category: errorField('Section', categorySelect, 'err-category'),
  };

  /** A pristine form is not a wrong form: a field's problems stay hidden until
   *  the user has been in it, or until they ask to save. */
  const touched = new Set<FormField>();
  let submitted = false;
  for (const name of FORM_FIELDS) {
    // `category` is deliberately not in this loop. Its only failure is the
    // name of the section "New section…" reveals, and choosing that option is
    // not yet an answer to it: the blank-name error belongs to the row below,
    // which marks the field touched as soon as it is typed into.
    if (name === 'category') continue;
    inputs[name].addEventListener('input', () => touched.add(name));
    inputs[name].addEventListener('blur', () => {
      // An empty field the user only tabbed through has not been answered
      // wrongly yet; the autofocused one would otherwise turn red on the very
      // first click anywhere on the page.
      if (touched.has(name) || !inputs[name].value.trim()) return;
      touched.add(name);
      recompute();
    });
  }
  sectionInput.addEventListener('input', () => touched.add('category'));

  categorySelect.addEventListener('change', () => {
    const creating = categorySelect.value === NEW_SECTION_VALUE;
    sectionRow.hidden = !creating;
    if (creating) {
      sectionInput.focus();
    } else {
      // A label left behind in a hidden row would fail validation from a
      // control nothing on the page shows.
      sectionInput.value = '';
      touched.delete('category');
    }
    recompute();
  });

  const form = el('div', { class: 'form' });
  form.append(
    slots.keys.node,
    field('Name', nameInput),
    field('Description', descInput, undefined, true),
    slots.url.node,
    slots.searchUrl.node,
    field('Example', exampleInput),
    slots.category.node,
    sectionRow,
  );

  const preview = el('div', {
    class: 'preview',
    children: [
      el('div', {
        class: 'preview-head',
        children: [
          el('h3', { text: 'Live preview' }),
          el('div', {
            class: 'preview-sample',
            children: [el('span', { text: 'sample arguments' }), sampleInput],
          }),
        ],
      }),
      previewRows,
    ],
  });

  const resetButton = button('Reset', () => setDraft(baseline ?? emptyDraft()), 'btn btn-ghost');
  resetButton.hidden = baseline === null;

  // "Edit <name>" / "New shortcut" says which mode this is; only the New form
  // gets a sub-line, because it is the one case where the field labels alone
  // do not say what to do first.
  const headText: HTMLElement[] = [
    el('h2', {
      class: 'panel-title',
      text: entry ? `Edit ${entry.cmd.name}` : 'New shortcut',
    }),
  ];
  if (!entry) {
    headText.push(
      el('p', {
        class: 'panel-sub',
        text: 'Type a keyword and a destination. The preview below is the real resolver, so what it shows is exactly where the address bar will land.',
      }),
    );
  }

  const panel = el('section', { class: 'panel' });
  panel.append(
    el('div', {
      class: 'panel-head',
      children: [el('div', { class: 'panel-head-text', children: headText })],
    }),
    el('div', {
      class: 'panel-body',
      children: [
        form,
        preview,
        previewNote,
        messages,
        el('div', {
          class: 'form-actions',
          children: [
            saveButton,
            resetButton,
            button('Cancel', () => go('#help'), 'btn'),
          ],
        }),
      ],
    }),
  );

  function readDraft(): Draft {
    return {
      keys: keysInput.value,
      name: nameInput.value,
      description: descInput.value,
      url: urlInput.value,
      searchUrl: searchInput.value,
      category: categorySelect.value,
      example: exampleInput.value,
      newSectionLabel: sectionInput.value,
    };
  }

  /** Refills the inputs. Form-level and nothing more: on/off, deleted state and
   *  storage are untouched until Save. */
  function setDraft(next: Draft): void {
    keysInput.value = next.keys;
    nameInput.value = next.name;
    descInput.value = next.description;
    urlInput.value = next.url;
    searchInput.value = next.searchUrl;
    exampleInput.value = next.example;
    categorySelect.value = next.category;
    sectionInput.value = '';
    sectionRow.hidden = true;
    touched.delete('category');
    recompute();
  }

  // `validateDraft` is pure, so it needs to be handed the ownership map, the user's
  // own shortcuts and the shipped registry explicitly: this is that context,
  // rebuilt from the current store state each time it is needed.
  function currentContext(): FormContext {
    return {
      editingId: target.id,
      owners: buildKeyOwner(browseEntries(BUILTIN_COMMANDS, getState().overrides)),
      custom: getState().overrides.custom,
      builtins: BUILTIN_COMMANDS,
      sections: getState().overrides.sections,
    };
  }

  function recompute(): void {
    const current = readDraft();
    const problems = validateDraft(current, currentContext());
    // The pooled list carries only what no single field owns.
    paintProblems(messages, problems.filter((problem) => problem.field === undefined));
    for (const name of FORM_FIELDS) {
      const visible = submitted || touched.has(name);
      slots[name].setProblems(
        visible ? problems.filter((problem) => problem.field === name) : [],
      );
    }
    // Nothing left to put back is the one state where Reset would do nothing at
    // all, and a button that does nothing should say so before it is pressed.
    resetButton.disabled = baseline !== null && sameDraft(current, baseline);
    paintPreview(current, target, previewRows, previewNote);
  }

  async function submit(): Promise<void> {
    submitted = true;
    const current = readDraft();
    const problems = validateDraft(current, currentContext());
    recompute();
    if (problems.some((problem) => problem.level === 'error')) {
      const offending = FORM_FIELDS.find((name) =>
        problems.some((problem) => problem.level === 'error' && problem.field === name),
      );
      if (offending === 'category') sectionInput.focus();
      else if (offending) inputs[offending].focus();
      return;
    }

    let overrides = getState().overrides;
    let category = current.category;
    if (category === NEW_SECTION_VALUE) {
      // The section and the shortcut land in the SAME write below: a section
      // created by a save that then failed would be a group the user never
      // asked for, sitting empty in the list.
      const added = addSection(overrides, current.newSectionLabel);
      if (!added.id) {
        slots.category.setProblems([
          {
            level: 'error',
            field: 'category',
            text: `That section could not be added. A profile holds at most ${MAX_SECTIONS} sections. Delete one first, or pick an existing section.`,
          },
        ]);
        sectionInput.focus();
        return;
      }
      overrides = added.overrides;
      category = added.id;
    }

    const known = knownCategoryIds(overrides.sections);
    // Minted here rather than left to `saveOverrides`: the row the next render
    // puts on screen needs a real id for its Edit and Delete links, and an
    // optimistic copy without one no longer matches the blob that comes back
    // through `onStateChanged`, costing a full repaint on every new shortcut.
    // Storage honours a `u:` claim, and minting is deterministic, so it mints
    // the same id we did.
    const id =
      target.id ||
      mintUserId(
        splitKeys(current.keys)[0] ?? '',
        new Set(overrides.custom.map(shortcutId)),
      );
    const cmd = buildCommand({ ...current, category }, known, target.base, id);

    let next: Overrides;
    if (target.shipped && target.base) {
      // Null-prototype: an id is a key off untrusted storage, and
      // `edits['__proto__'] = …` on a plain object is swallowed by the
      // inherited setter.
      const edits: Record<string, ShortcutEdit> = Object.assign(
        Object.create(null),
        overrides.edits,
      );
      // A diff, not a copy: a shortcut edited back to its shipped definition
      // stores nothing, so a corrected URL in a later build still reaches it.
      const edit = diffEdit(target.base, cmd, known);
      if (edit) edits[id] = edit;
      else delete edits[id];
      next = { ...overrides, edits };
    } else if (target.id) {
      // By id, not by canonical key: a shortcut whose keys changed is still the
      // same shortcut.
      next = {
        ...overrides,
        custom: overrides.custom.map((existing) =>
          shortcutId(existing) === target.id ? cmd : existing,
        ),
      };
    } else {
      next = { ...overrides, custom: [...overrides.custom, cmd] };
    }

    try {
      await commitOverrides(next);
    } catch (err) {
      paintProblems(messages, [{ level: 'error', text: `Could not save: ${errorText(err)}` }]);
      return;
    }
    setNotice({ tone: 'ok', text: `Saved “${cmd.name}”. Type ${cmd.keys[0]} in the address bar to use it.` });
    go('#help');
  }

  panel.addEventListener('input', (event) => {
    if (event.target === sampleInput) setSampleArgs(sampleInput.value);
    recompute();
  });
  recompute();
  window.setTimeout(() => keysInput.focus(), 0);

  return panel;
}

export function paintProblems(host: HTMLElement, problems: Problem[]): void {
  host.textContent = '';
  for (const problem of problems) {
    host.append(
      el('p', {
        class: problem.level === 'error' ? 'msg msg-error' : 'msg msg-warn',
        text: problem.text,
      }),
    );
  }
}

export function paintPreview(
  draft: Draft,
  target: FormTarget,
  rows: HTMLElement,
  note: HTMLElement,
): void {
  rows.textContent = '';
  note.textContent = '';
  note.hidden = true;
  // Both notes can be true at once, a switched-off shortcut rebound onto a
  // keyword something else owns, and one silently replacing the other is how
  // the user reads the wrong explanation for what the rows are showing.
  const notes: string[] = [];

  const keys = splitKeys(draft.keys);
  if (keys.length === 0 || !draft.url.trim()) {
    rows.append(
      el('div', {
        class: 'preview-row',
        children: [
          el('span', { class: 'preview-typed faint', text: 'a keyword and a URL' }),
          el('span', { class: 'preview-arrow', text: '→' }),
          el('span', { class: 'preview-url faint', text: 'nothing to preview yet' }),
        ],
      }),
    );
    return;
  }

  const overrides = getState().overrides;
  const cmd = buildCommand(draft, knownCategoryIds(overrides.sections), target.base, target.id);
  // The registry list with the draft substituted at the shortcut's own index,
  // NOT the draft prepended as a custom command: `buildKeyMap` is
  // first-writer-wins, and prepending handed the draft every alias it claimed,
  // including ones an earlier builtin owns and keeps after the save.
  const commands = previewCommands(BUILTIN_COMMANDS, overrides, cmd, target.id, target.shipped);
  const switchedOff =
    target.id !== '' && overrides.disabled.some((id) => normalizeId(id) === target.id);
  const key = keys[0];
  const sampleArgs = getSampleArgs();
  const withArgs = sampleArgs.trim() ? `${key} ${sampleArgs.trim()}` : key;

  for (const typed of withArgs === key ? [key] : [key, withArgs]) {
    const result = resolve(typed, commands, getState().settings);
    // Same as the omnibox and the popup: the passthrough marker is plumbing.
    const shown = stripPassthrough(result.url);
    rows.append(
      el('div', {
        class: 'preview-row',
        children: [
          el('span', { class: 'preview-typed', text: typed }),
          el('span', { class: 'preview-arrow', text: '→' }),
          el('span', {
            class: result.fallback ? 'preview-url is-fallback' : 'preview-url',
            text: shown,
            title: shown,
          }),
        ],
      }),
    );
    // A key already owned by an earlier command means this preview is showing
    // somebody else's destination, which is worth spelling out.
    const owner = result.command;
    if (owner && owner.name !== cmd.name) {
      const text = `“${key}” currently resolves to ${owner.name}, not this shortcut.`;
      if (!notes.includes(text)) notes.push(text);
    }
  }

  // The preview is about the definition, so a switched-off shortcut is
  // previewed as if it were on. Without saying so, the rows would show the
  // destination while the address bar ran a plain web search.
  if (switchedOff) {
    notes.push(
      'This shortcut is switched off; the address bar searches until you switch it back on.',
    );
  }

  note.textContent = notes.join(' ');
  note.hidden = notes.length === 0;
}
