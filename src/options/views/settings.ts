/**
 * The "Settings" route: the values the smart handlers read, the section list,
 * search interception, the keyword exemption list, and (via `renderData`)
 * import/export.
 */

import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../../lib/commands';
import {
  MAX_SECTIONS,
  addSection,
  deleteSection,
  isShippedSection,
  renameSection,
  sectionKey,
  sectionLabel,
  sectionLabelTaken,
  sectionMembers,
  sectionOptions,
} from '../../lib/overrides';
import type { Overrides, SearchEngineId } from '../../lib/types';
import { DEFAULT_SETTINGS, FALLBACK_SECTION } from '../../lib/types';
import { validateSectionLabel } from '../../lib/validate';
import { el, nextId } from '../../ui/dom';
import {
  button,
  checkbox,
  confirmButton,
  errorField,
  field,
  flash,
  iconButton,
  panelCard,
  selectControl,
  textInput,
} from '../dom';
import { buildKeyOwner, browseEntries } from '../model/browse';
import { engineProblem } from '../model/form';
import { go } from '../router';
import { getStatus, runtimeId, setSuppressedHost } from '../rule-status';
import { commitOverrides, commitSettings, getState, reportFailure, stopSet } from '../store';
import { countShortcuts, renderData } from './data';

const ENGINE_PRESETS: { label: string; template: string }[] = [
  { label: 'Google', template: 'https://www.google.com/search?q={q}' },
  { label: 'Bing', template: 'https://www.bing.com/search?q={q}' },
  { label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={q}' },
  { label: 'Kagi', template: 'https://kagi.com/search?q={q}' },
  { label: 'Brave Search', template: 'https://search.brave.com/search?q={q}' },
];

export function renderSettings(): Node[] {
  return [renderDefaults(), renderSections(), renderInterception(), renderStopList(), renderData()];
}

export function renderDefaults(): HTMLElement {
  const card = panelCard('Default Usernames');

  const githubInput = textInput(getState().settings.githubUser, 'octocat');
  githubInput.addEventListener('change', () => {
    void commitSettings(
      { ...getState().settings, githubUser: githubInput.value.trim() },
      card.saved,
    );
  });

  const engineInput = textInput(
    getState().settings.defaultEngine,
    DEFAULT_SETTINGS.defaultEngine,
    true,
  );
  const engineField = errorField(
    'Fallback URL template',
    engineInput,
    'err-engine',
    undefined,
    true,
  );
  const enginePreset = selectControl(
    [
      ...ENGINE_PRESETS.map((preset) => ({ value: preset.template, label: preset.label })),
      { value: 'custom', label: 'Custom…' },
    ],
    ENGINE_PRESETS.some((preset) => preset.template === getState().settings.defaultEngine)
      ? getState().settings.defaultEngine
      : 'custom',
  );

  const syncPreset = (value: string): void => {
    enginePreset.value = ENGINE_PRESETS.some((preset) => preset.template === value)
      ? value
      : 'custom';
  };

  enginePreset.addEventListener('change', () => {
    if (enginePreset.value === 'custom') {
      engineInput.focus();
      engineInput.select();
      return;
    }
    engineInput.value = enginePreset.value;
    engineField.setProblems([]);
    void commitSettings({ ...getState().settings, defaultEngine: enginePreset.value }, card.saved);
  });

  engineInput.addEventListener('change', () => {
    // This one field decides where every unmatched search on all three surfaces
    // lands, so a rejected value must not be written and must not flash "Saved".
    const value = engineInput.value.trim() || DEFAULT_SETTINGS.defaultEngine;
    const problem = engineProblem(value);
    if (problem) {
      engineField.setProblems([problem]);
      return;
    }
    engineField.setProblems(
      value.includes('{q}') || value.includes('%s')
        ? []
        : [
            {
              level: 'warn',
              field: 'url',
              text: 'No {q} in this template, so BunnyLol appends ?q=… to it. Add {q} to put the query where the engine expects it.',
            },
          ],
    );
    engineInput.value = value;
    syncPreset(value);
    void commitSettings({ ...getState().settings, defaultEngine: value }, card.saved);
  });

  const accountInput = el('input', {
    class: 'input',
    attrs: { type: 'number', min: '0', step: '1', inputmode: 'numeric' },
  });
  accountInput.value = String(getState().settings.googleAccount);
  accountInput.addEventListener('change', () => {
    const parsed = Math.max(0, Math.floor(Number(accountInput.value) || 0));
    accountInput.value = String(parsed);
    void commitSettings({ ...getState().settings, googleAccount: parsed }, card.saved);
  });

  card.body.append(
    el('div', {
      class: 'form',
      children: [
        field('GitHub username', githubInput),
        field('Fallback search engine', enginePreset),
        field(
          'Google account index',
          accountInput,
          'The N in /u/N/. Account 0 is the one you signed in with first.',
        ),
        engineField.node,
      ],
    }),
  );
  return card.section;
}

/**
 * The headings the browse list draws, and the three different acts that shape
 * them: renaming a shipped group (which stores a section entry whose id IS the
 * shipped category id), renaming or deleting one the user made, and adding one.
 *
 * They are one card because to the user they are one list: the same groups in
 * the same order the browse page shows them. A section that ships is not
 * labelled as one; it simply has no Delete, which is the whole of what the
 * distinction means here.
 */
export function renderSections(): HTMLElement {
  const card = panelCard('Sections');

  const rows = el('div', { class: 'rows' });

  const commit = (next: Overrides): void => {
    void commitOverrides(next)
      .then(() => {
        flash(card.saved);
        paint();
      })
      .catch(reportFailure);
  };

  const capMessage = `You already have ${MAX_SECTIONS} sections, which is as many as BunnyLol keeps.`;

  function sectionRow(id: string, label: string): HTMLElement {
    const overrides = getState().overrides;
    const shipped = isShippedSection(id);
    const members = sectionMembers(id, BUILTIN_COMMANDS, overrides).length;

    // The row shows the name as text and swaps in this field only while it is
    // being edited, so the card reads like the shortcut list rather than like a
    // form. The input is built once and moved, so nothing below has to care
    // which state the row is in.
    const input = textInput(label, label);
    input.setAttribute('aria-label', `Name of the ${label} section`);
    const nameHost = el('div', { class: 'row-name', text: label });
    const errors = el('div', {
      class: 'field-errors',
      id: nextId('section-err'),
      attrs: { 'aria-live': 'polite' },
    });

    const setError = (text: string): void => {
      errors.textContent = '';
      input.classList.toggle('bad', text !== '');
      if (!text) {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
        return;
      }
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', errors.id);
      errors.append(el('p', { class: 'msg msg-error', text }));
    };

    /** The one write both Rename and Restore-default-name go through, so the
     *  clash check and the cap refusal cannot be applied to one and not the
     *  other, which is exactly how two sections both ended up called
     *  "Developer". */
    const applyRename = (wanted: string): void => {
      const overrides = getState().overrides;
      // Already what it is called: a second click on Restore before the commit
      // repainted the row, which would otherwise reach the refusal below.
      if (sectionLabel(id, overrides.sections) === wanted) {
        setError('');
        return;
      }
      if (sectionLabelTaken(wanted, overrides.sections, id)) {
        setError(`Another section is already called “${wanted}”.`);
        return;
      }
      const next = renameSection(overrides, id, wanted);
      // Nothing else can hand back the same object here: the label is valid, it
      // is not the one on screen, and it is free. `renameSection` refuses past
      // the cap because renaming a shipped group APPENDS an entry.
      if (next === overrides) {
        setError(capMessage);
        return;
      }
      setError('');
      commit(next);
    };

    const rename = (): void => {
      const check = validateSectionLabel(input.value);
      if (!check.ok) {
        setError(`That name ${check.reason}.`);
        return;
      }
      if (check.label === label) {
        // Shown as it would have been stored, so the field stops offering
        // whitespace the save was never going to keep.
        input.value = check.label;
        setError('');
        return;
      }
      applyRename(check.label);
    };

    let editing = false;

    const stopEdit = (): void => {
      if (!editing) return;
      editing = false;
      input.remove();
      nameHost.textContent = label;
    };

    const startEdit = (): void => {
      if (editing) return;
      editing = true;
      // From the stored label rather than from whatever the last rejected
      // attempt left behind, so reopening the field is a fresh start.
      input.value = label;
      setError('');
      nameHost.textContent = '';
      nameHost.append(input);
      input.focus();
      input.select();
    };

    const pencil = iconButton(`Rename the ${label} section`, 'pencil', startEdit);

    input.addEventListener('change', rename);
    // Enter commits through `blur` rather than by calling `rename` itself: the
    // commit repaints these rows, and a keydown that renamed directly would
    // then get the `change` event the blur fires on the detached input and
    // write the same rename a second time.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // Restored BEFORE the field leaves the DOM, so the `change` event that a
      // modified value would otherwise fire on the way out never happens: an
      // abandoned edit must not write anything.
      input.value = label;
      setError('');
      stopEdit();
      pencil.focus();
    });
    input.addEventListener('blur', () => {
      // A rejected name keeps its field, because the error under it is about
      // text that would otherwise no longer be on screen.
      if (errors.textContent) return;
      stopEdit();
    });

    // Just the count. Which sections ship with BunnyLol is already legible from
    // the row: a shipped one has no Delete, because it cannot be deleted.
    const desc = el('div', {
      class: 'row-desc',
      children: [el('span', { class: 'count', text: countShortcuts(members) })],
    });

    // Rename, then Delete, in the order and with the glyphs the shortcut rows
    // use. Restore-default-name sits between them and only for a shipped
    // section that carries a stored rename, which is the only row it can do
    // anything on. It stays outside the edit state so that clicking it never
    // races the field's own blur.
    const actions = el('div', { class: 'row-actions', children: [pencil] });
    if (shipped && overrides.sections.some((section) => sectionKey(section.id) === id)) {
      actions.append(
        button(
          'Restore default name',
          // `renameSection` answers a rename back to the shipped label by
          // dropping the entry, so this leaves the blob it started from rather
          // than a stored rename that changes nothing. It goes through the same
          // guard as a typed rename: the shipped name can have been taken by
          // another section while this one was called something else.
          () => applyRename(sectionLabel(id, [])),
          'btn btn-sm btn-ghost',
        ),
      );
    }
    if (!shipped) {
      const moves = members === 1 ? '1 shortcut moves' : `${members} shortcuts move`;
      actions.append(
        confirmButton(
          `Delete the ${label} section`,
          members === 0
            ? 'Click again: the section is empty'
            : `Click again: ${moves} to ${fallbackLabel()}`,
          // Ghost, like every other row action: the red belongs to the armed
          // state `confirmButton` adds, not to a button that has not been
          // asked to do anything yet.
          'btn btn-sm btn-ghost btn-icon',
          () => commit(deleteSection(getState().overrides, id)),
          'trash',
        ),
      );
    }

    return el('div', {
      class: 'row section-row',
      children: [el('div', { class: 'row-body', children: [nameHost, errors, desc] }), actions],
    });
  }

  function paint(): void {
    rows.textContent = '';
    const overrides = getState().overrides;
    const commands = browseEntries(BUILTIN_COMMANDS, overrides).map((entry) => entry.cmd);
    for (const section of sectionOptions(overrides.sections, commands)) {
      rows.append(sectionRow(section.id, section.label));
    }
  }

  const addInput = textInput('', 'Client work');
  const addField = errorField('New section', addInput, 'err-section');

  const add = (): void => {
    const overrides = getState().overrides;
    const check = validateSectionLabel(addInput.value);
    if (!check.ok) {
      addField.setProblems([{ level: 'error', text: `That name ${check.reason}.` }]);
      return;
    }
    if (sectionLabelTaken(check.label, overrides.sections)) {
      addField.setProblems([
        { level: 'error', text: `There is already a section called “${check.label}”.` },
      ]);
      return;
    }
    const added = addSection(overrides, check.label);
    if (!added.id) {
      addField.setProblems([{ level: 'error', text: capMessage }]);
      return;
    }
    addInput.value = '';
    addField.setProblems([]);
    commit(added.overrides);
  };

  addInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  });

  paint();

  card.body.append(
    rows,
    el('div', {
      class: 'row section-row',
      children: [
        el('div', { class: 'row-body', children: [addField.node] }),
        el('div', {
          class: 'row-actions',
          children: [button('Add section', add, 'btn')],
        }),
      ],
    }),
    el('div', {
      class: 'row section-row',
      children: [
        el('div', {
          class: 'row-body',
          children: [
            el('div', { class: 'row-name', text: 'Shortcut packs' }),
            el('div', {
              class: 'row-desc',
              text: 'Enable or disable default shortcut packs',
            }),
          ],
        }),
        el('div', {
          class: 'row-actions',
          children: [button('Choose shortcut packs…', () => go('#packs'), 'btn')],
        }),
      ],
    }),
  );
  return card.section;
}

/** What "My shortcuts" is called right now: it is a shipped section like any
 *  other, so the copy that promises where a deleted section's members land has
 *  to name the heading the user will actually go looking for. */
function fallbackLabel(): string {
  return sectionLabel(FALLBACK_SECTION, getState().overrides.sections);
}

export function renderInterception(): HTMLElement {
  const card = panelCard(
    'Search interception',
    'BunnyLol will work when you try to search using one of these engines. bl always works irrespective of engine.',
  );

  const checks = el('div', { class: 'checks' });
  for (const engine of SEARCH_ENGINES) {
    checks.append(
      checkbox(engine.label, getState().settings.interceptEngines.includes(engine.id), (on) => {
        const set = new Set<SearchEngineId>(getState().settings.interceptEngines);
        if (on) set.add(engine.id);
        else set.delete(engine.id);
        const interceptEngines = SEARCH_ENGINES.map((item) => item.id).filter((id) => set.has(id));
        void commitSettings({ ...getState().settings, interceptEngines }, card.saved);
      }),
    );
  }

  const id = getStatus()?.extensionId || runtimeId();
  const searchUrl = `chrome-extension://${id}/go.html?q=%s`;
  const copyState = el('span', { class: 'saved' });
  const copyButton = button(
    'Copy',
    () => {
      void navigator.clipboard
        .writeText(searchUrl)
        .then(() => flash(copyState, 'Copied'))
        .catch(() => flash(copyState, 'Copy failed'));
    },
    'btn btn-sm',
  );

  card.body.append(
    checks,
    el('div', {
      class: 'code-block',
      children: [el('code', { text: searchUrl }), copyButton, copyState],
    }),
    el('p', {
      class: 'field-hint',
      text: 'Optional alternative: add that URL as a custom search engine at chrome://settings/searchEngines and give it a keyword. Interception above already covers the common case.',
    }),
    checkbox('Confirm before opening a shortcut', getState().settings.dispatchToast, (on) => {
      void commitSettings({ ...getState().settings, dispatchToast: on }, card.saved);
    }),
  );
  return card.section;
}

/**
 * The exemption list. Empty by default, and the copy has to say why: a user who
 * reads "excluded because they are common words" will look for the list that
 * protects them and find nothing.
 */
export function renderStopList(): HTMLElement {
  const card = panelCard(
    'Exempt keywords',
    'These keywords are not matched to a shortcut. They are searched directly.',
  );

  const chips = el('div', { class: 'chip-row' });
  const addInput = textInput('', 'new', true);
  const addField = errorField(
    'Exempt a keyword',
    addInput,
    'err-stop',
    'Lowercase, no spaces. The shortcut keeps working through bl and the popup.',
  );

  const suppressedHost = el('p', {
    class: 'field-hint',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  setSuppressedHost(suppressedHost);

  const commitList = (next: string[]): void => {
    const unique = [...new Set(next.map((key) => key.trim().toLowerCase()).filter(Boolean))].sort();
    void commitSettings({ ...getState().settings, interceptStopList: unique }, card.saved).then(
      paintChips,
    );
  };

  function paintChips(): void {
    chips.textContent = '';
    const list = [...stopSet()].sort();
    // No empty state. An empty exemption list is the default and the ordinary
    // case, so a line announcing it is a sentence most people read once and
    // never need.
    for (const key of list) {
      const remove = button('×', () => commitList(list.filter((item) => item !== key)), 'chip-x');
      remove.setAttribute('aria-label', `Intercept ${key} again`);
      remove.title = `Stop exempting “${key}”`;
      chips.append(el('span', { class: 'chip chip-removable', children: [key, remove] }));
    }
  }

  const add = (): void => {
    const key = addInput.value.trim().toLowerCase();
    if (!key) return;
    if (/\s/.test(key)) {
      addField.setProblems([
        { level: 'error', text: 'One keyword at a time. A keyword cannot contain a space.' },
      ]);
      return;
    }
    if (stopSet().has(key)) {
      addField.setProblems([{ level: 'error', text: `“${key}” is already exempt.` }]);
      return;
    }
    addInput.value = '';
    addField.setProblems(
      buildKeyOwner(browseEntries(BUILTIN_COMMANDS, getState().overrides)).has(key)
        ? []
        : [{ level: 'warn', text: `No shortcut uses “${key}” right now, so nothing changes yet.` }],
    );
    commitList([...stopSet(), key]);
  };

  addInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  });

  paintChips();

  card.body.append(
    chips,
    el('div', {
      class: 'stop-add',
      children: [
        addField.node,
        el('div', {
          class: 'btn-row',
          children: [
            button('Add', add, 'btn'),
            button('Intercept everything', () => commitList([]), 'btn'),
          ],
        }),
      ],
    }),
    suppressedHost,
  );
  return card.section;
}
