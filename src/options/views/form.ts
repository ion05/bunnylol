/**
 * The "New shortcut" / "Edit" route: one form, backed by `model/form.ts`'s
 * pure validation and command-building. The `textContent` rule `views/browse.ts`
 * documents applies here too — this view echoes the draft back in the live
 * preview.
 */

import { BUILTIN_COMMANDS } from '../../lib/commands';
import type { Draft } from '../../lib/draft';
import { parsePrefill, splitKeys } from '../../lib/draft';
import { knownCategoryIds, mintUserId, sectionOptions, shortcutId } from '../../lib/overrides';
import { mergeCommands, resolve, stripPassthrough } from '../../lib/resolve';
import { errorText } from '../../lib/text';
import { el } from '../../ui/dom';
import { button, errorField, field, selectControl, textInput } from '../dom';
import type { FieldSlot } from '../dom';
import { buildKeyOwner, browseEntries } from '../model/browse';
import type { FormContext, FormField, Problem } from '../model/form';
import { FORM_FIELDS, buildCommand, previewOverrides, validateDraft } from '../model/form';
import { go } from '../router';
import {
  commitOverrides,
  getRoute,
  getSampleArgs,
  getState,
  setNotice,
  setSampleArgs,
} from '../store';

export function renderForm(): HTMLElement {
  const route = getRoute();
  const editingKey = route.name === 'edit' ? (route.params.get('key') ?? '').toLowerCase() : '';
  const existing = editingKey
    ? getState().overrides.custom.find((cmd) => shortcutId(cmd) === editingKey)
    : undefined;
  const editing = existing ? editingKey : '';

  const draft: Draft = existing
    ? {
        keys: existing.keys.join(', '),
        name: existing.name,
        description: existing.description,
        url: existing.url,
        searchUrl: existing.searchUrl ?? '',
        category: existing.category,
        example: '',
        newSectionLabel: '',
      }
    : parsePrefill(route.params.get('prefill') ?? '');

  const keysInput = textInput(draft.keys, 'gh, github', true);
  const nameInput = textInput(draft.name, 'GitHub');
  const descInput = textInput(draft.description, 'Open a repo, or search GitHub.');
  const urlInput = textInput(draft.url, 'https://github.com', true);
  const searchInput = textInput(draft.searchUrl, 'https://github.com/search?q={q}', true);
  const categorySelect = selectControl(
    // The sections that exist, not the shipped list: a shortcut filed under one
    // of the user's own sections must not be silently moved to whatever the
    // select happens to show first when they open the form.
    sectionOptions(
      getState().overrides.sections,
      mergeCommands(BUILTIN_COMMANDS, getState().overrides),
    ).map((section) => ({ value: section.id, label: section.label })),
    draft.category,
  );

  const sampleInput = textInput(getSampleArgs(), 'arguments');
  sampleInput.setAttribute('aria-label', 'Sample arguments for the preview');
  const previewRows = el('div', { class: 'preview-rows' });
  const previewNote = el('p', { class: 'field-hint' });
  previewNote.hidden = true;

  const messages = el('div', { class: 'msg-list', attrs: { 'aria-live': 'polite' } });
  const saveButton = button('Save shortcut', () => void submit(), 'btn btn-primary');

  const inputs: Record<FormField, HTMLInputElement> = {
    keys: keysInput,
    url: urlInput,
    searchUrl: searchInput,
  };
  const slots: Record<FormField, FieldSlot> = {
    keys: errorField(
      'Keywords',
      keysInput,
      'err-keys',
      'Comma-separated. The first one is canonical.',
    ),
    url: errorField('Destination URL', urlInput, 'err-url', 'Where the bare keyword goes.', true),
    searchUrl: errorField(
      'Search URL',
      searchInput,
      'err-searchurl',
      'Optional. Put {q} where the arguments belong. Without it, BunnyLol appends ?q=…',
      true,
    ),
  };

  /** A pristine form is not a wrong form: a field's problems stay hidden until
   *  the user has been in it, or until they ask to save. */
  const touched = new Set<FormField>();
  let submitted = false;
  for (const name of FORM_FIELDS) {
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

  const form = el('div', { class: 'form' });
  form.append(
    slots.keys.node,
    field('Name', nameInput, 'Shown in this list and in the omnibox dropdown.'),
    field(
      'Description',
      descInput,
      'Optional. One line explaining what the shortcut does.',
      true,
    ),
    slots.url.node,
    slots.searchUrl.node,
    field('Category', categorySelect, 'Only affects grouping on this page.'),
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

  const panel = el('section', { class: 'panel' });
  panel.append(
    el('div', {
      class: 'panel-head',
      children: [
        el('div', {
          class: 'panel-head-text',
          children: [
            el('h2', {
              class: 'panel-title',
              text: editing ? `Edit ${existing?.name ?? 'shortcut'}` : 'New shortcut',
            }),
            el('p', {
              class: 'panel-sub',
              text: 'Type a keyword and a destination. The preview below is the real resolver — what it shows is exactly where the address bar will land.',
            }),
          ],
        }),
      ],
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
            button('Cancel', () => go('#help'), 'btn'),
            el('span', { class: 'spacer' }),
            el('span', { class: 'field-hint', text: 'Escape closes without saving.' }),
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
      example: '',
      newSectionLabel: '',
    };
  }

  // `validateDraft` is pure, so it needs to be handed the ownership map, the user's
  // own shortcuts and the shipped registry explicitly — this is that context,
  // rebuilt from the current store state each time it is needed.
  function currentContext(): FormContext {
    return {
      editingId: editing,
      owners: buildKeyOwner(browseEntries(BUILTIN_COMMANDS, getState().overrides)),
      custom: getState().overrides.custom,
      builtins: BUILTIN_COMMANDS,
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
    paintPreview(current, editing, previewRows, previewNote);
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
      if (offending) inputs[offending].focus();
      return;
    }
    const cmd = buildCommand(current, knownCategoryIds(getState().overrides.sections));
    const custom = editing
      ? getState().overrides.custom.map((existingCmd) =>
          // The id is carried across explicitly: a shortcut whose keys changed is
          // still the same shortcut, and `buildCommand` only knows the form.
          shortcutId(existingCmd) === editing ? { ...cmd, id: editing } : existingCmd,
        )
      : [
          ...getState().overrides.custom,
          // Minted here rather than left to `saveOverrides`: the row this
          // render puts on screen needs a real id for its Edit and Delete
          // links, and an optimistic copy without one no longer matches the
          // blob that comes back through `onStateChanged`, costing a full
          // repaint on every new shortcut. Storage honours a `u:` claim, and
          // minting is deterministic, so it mints the same id we did.
          {
            ...cmd,
            id: mintUserId(
              cmd.keys[0] ?? '',
              new Set(getState().overrides.custom.map(shortcutId)),
            ),
          },
        ];
    try {
      await commitOverrides({ ...getState().overrides, custom });
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
  editing: string,
  rows: HTMLElement,
  note: HTMLElement,
): void {
  rows.textContent = '';
  note.hidden = true;

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

  const cmd = buildCommand(draft, knownCategoryIds(getState().overrides.sections));
  const previewCommands = mergeCommands(
    BUILTIN_COMMANDS,
    previewOverrides(cmd, editing, getState().overrides),
  );
  const key = keys[0];
  const sampleArgs = getSampleArgs();
  const withArgs = sampleArgs.trim() ? `${key} ${sampleArgs.trim()}` : key;

  for (const typed of withArgs === key ? [key] : [key, withArgs]) {
    const result = resolve(typed, previewCommands, getState().settings);
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
    if (result.command && result.command.name !== cmd.name) {
      note.textContent = `“${key}” currently resolves to ${result.command.name}, not this shortcut.`;
      note.hidden = false;
    }
  }
}
