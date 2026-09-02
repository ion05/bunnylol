/**
 * The "Settings" route: defaults, the section list, the undo for a deleted
 * shipped shortcut, search interception, the address-bar exemption list, AI
 * prompt templates, and (via `renderData`) import/export.
 */

import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../../lib/commands';
import { AI_PROVIDERS } from '../../lib/handlers';
import {
  MAX_SECTIONS,
  addSection,
  applyEdit,
  deleteSection,
  isShippedSection,
  knownCategoryIds,
  renameSection,
  restorableShipped,
  sectionKey,
  sectionLabel,
  sectionLabelTaken,
  sectionMembers,
  sectionOptions,
  shortcutId,
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
  panelCard,
  selectControl,
  textInput,
} from '../dom';
import { buildKeyOwner, browseEntries } from '../model/browse';
import { engineProblem } from '../model/form';
import { go } from '../router';
import { getStatus, runtimeId, setSuppressedHost } from '../rule-status';
import {
  commitOverrides,
  commitSettings,
  getCommands,
  getState,
  reportFailure,
  stopSet,
} from '../store';
import { countShortcuts, renderData } from './data';

const ENGINE_PRESETS: { label: string; template: string }[] = [
  { label: 'Google', template: 'https://www.google.com/search?q={q}' },
  { label: 'Bing', template: 'https://www.bing.com/search?q={q}' },
  { label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={q}' },
  { label: 'Kagi', template: 'https://kagi.com/search?q={q}' },
  { label: 'Brave Search', template: 'https://search.brave.com/search?q={q}' },
];

export function renderSettings(): Node[] {
  return [
    renderDefaults(),
    renderSections(),
    renderRestore(),
    renderInterception(),
    renderStopList(),
    renderAiTemplates(),
    renderData(),
  ];
}

export function renderDefaults(): HTMLElement {
  const card = panelCard(
    'Defaults',
    'Values the smart handlers read: your GitHub user, where unmatched queries go, and which account Google links use.',
  );

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
    'Anything with {q} works, so a self-hosted or region-specific engine is one paste away.',
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

  // Keyed by provider id, not by alias: rebinding the Claude builtin's keyword
  // must not silently repoint `?` at somebody else.
  const aiOptions = AI_PROVIDERS.map((provider) => {
    const alias = getCommands().find((cmd) => cmd.provider === provider.id)?.keys[0];
    return { value: provider.id, label: alias ? `${provider.label} (${alias})` : provider.label };
  });
  const defaultAi = getState().settings.defaultAi;
  if (!aiOptions.some((option) => option.value === defaultAi)) {
    aiOptions.unshift({ value: defaultAi, label: defaultAi });
  }
  const aiSelect = selectControl(aiOptions, defaultAi);
  aiSelect.addEventListener('change', () => {
    void commitSettings({ ...getState().settings, defaultAi: aiSelect.value }, card.saved);
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
        field('GitHub username', githubInput, 'Used by gh me, pr and iss.'),
        field(
          'Default AI',
          aiSelect,
          'Where the ? shortcut sends your prompt. Follows the provider, not its keyword.',
        ),
        field('Fallback search engine', enginePreset, 'Used when no keyword matches.'),
        field(
          'Google account index',
          accountInput,
          'The N in /u/N/ — 0 is the account you signed in with first.',
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
 * They are one card because to the user they are one list — the same groups in
 * the same order the browse page shows them, with the ones that ship marked so
 * it is clear why they cannot be deleted.
 */
export function renderSections(): HTMLElement {
  const card = panelCard(
    'Sections',
    `Group your shortcuts however you like. Renaming a shipped section only changes what it is called here — nothing moves. Deleting one of your own moves everything in it to ${fallbackLabel()}, so nothing is lost.`,
  );

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

    const input = textInput(label, label);
    input.setAttribute('aria-label', `Name of the ${label} section`);
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
     *  other — which is exactly how two sections both ended up called
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

    input.addEventListener('change', rename);
    // Enter commits through `blur` rather than by calling `rename` itself: the
    // commit repaints these rows, and a keydown that renamed directly would
    // then get the `change` event the blur fires on the detached input and
    // write the same rename a second time.
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      input.blur();
    });

    // "15 shortcuts · shipped": the count and what kind of section it is, in
    // the row's own description line rather than as a badge.
    const desc = el('div', {
      class: 'row-desc',
      children: [el('span', { class: 'count', text: countShortcuts(members) })],
    });
    if (shipped) {
      desc.append(
        el('span', {
          text: ' · shipped',
          title: 'Ships with BunnyLol. It can be renamed, but not deleted.',
        }),
      );
    }

    const actions = el('div', { class: 'row-actions' });
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
          members === 0 ? 'Delete' : `Delete · ${countShortcuts(members)}`,
          members === 0
            ? 'Click again — the section is empty'
            : `Click again — ${moves} to ${fallbackLabel()}`,
          'btn btn-sm btn-danger',
          () => commit(deleteSection(getState().overrides, id)),
        ),
      );
    }

    return el('div', {
      class: 'row section-row',
      children: [
        el('div', {
          class: 'row-body',
          children: [el('div', { class: 'row-name', children: [input] }), errors, desc],
        }),
        actions,
      ],
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
  const addField = errorField(
    'New section',
    addInput,
    'err-section',
    'It shows up in the browse list and in every shortcut’s Section menu.',
  );

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
              text: 'Turn whole groups of shipped shortcuts on or off at once. Continue on that screen re-enables every shortcut in the packs you pick, including ones you had switched off by hand.',
            }),
          ],
        }),
        el('div', {
          class: 'row-actions',
          children: [button('Choose shortcut packs…', () => go('#welcome'), 'btn')],
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

/**
 * Deleting a shipped shortcut is undoable, so there has to be somewhere the
 * undo lives. The card renders even when there is nothing in it — the same way
 * the stop-list card does — because a restore path that only appears once you
 * have already lost something is a path nobody finds when they need it.
 */
export function renderRestore(): HTMLElement {
  const card = panelCard(
    'Restore shipped shortcuts',
    'Shortcuts that ship with BunnyLol and that you deleted. Restoring one brings its shipped definition back, along with anything you had edited.',
  );

  const rows = el('div', { class: 'restore-rows' });

  const restore = (ids: string[]): void => {
    const overrides = getState().overrides;
    const dropped = new Set(ids);
    // Only `deleted` moves. `edits[id]` is left where it is, which is what
    // makes the sub above true.
    void commitOverrides({
      ...overrides,
      deleted: overrides.deleted.filter((id) => !dropped.has(id)),
    })
      .then(paint)
      .catch(reportFailure);
  };

  function paint(): void {
    rows.textContent = '';
    const overrides = getState().overrides;
    const known = knownCategoryIds(overrides.sections);
    const restorable = restorableShipped(BUILTIN_COMMANDS, overrides);
    if (restorable.length === 0) {
      rows.append(
        el('p', {
          class: 'field-hint',
          text: 'You have not deleted any shipped shortcuts.',
        }),
      );
      return;
    }

    for (const shipped of restorable) {
      const id = shortcutId(shipped);
      // Shown as it will come BACK, not as it shipped: the edit survives the
      // delete, so a renamed shortcut listed under its shipped name would send
      // the user looking for a row that never appears.
      const cmd = applyEdit({ ...shipped, id, keys: [...shipped.keys] }, overrides.edits[id], known);
      const keys = el('div', { class: 'row-keys' });
      for (const key of cmd.keys) keys.append(el('code', { class: 'chip', text: key }));
      rows.append(
        el('div', {
          class: 'row',
          children: [
            keys,
            el('div', {
              class: 'row-body',
              children: [
                el('div', { class: 'row-name', text: cmd.name }),
                el('div', { class: 'row-desc', text: cmd.description }),
              ],
            }),
            el('div', {
              class: 'row-actions',
              children: [button('Restore', () => restore([id]), 'btn btn-sm')],
            }),
          ],
        }),
      );
    }

    // With exactly one row the button would repeat the row's own action under
    // a longer name.
    if (restorable.length > 1) {
      rows.append(
        el('div', {
          class: 'restore-all',
          children: [
            button(
              `Restore all ${restorable.length}`,
              () => restore(restorable.map(shortcutId)),
              'btn',
            ),
          ],
        }),
      );
    }
  }

  paint();
  card.body.append(rows);
  return card.section;
}

export function renderInterception(): HTMLElement {
  const card = panelCard(
    'Search interception',
    'BunnyLol watches searches on the engines below and, when one starts with a keyword you own, redirects the tab before the request leaves your machine. Uncheck an engine to leave its searches alone.',
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
    el('p', {
      class: 'field-hint',
      text: 'You can also type bl followed by a shortcut in the address bar — that path always works, whatever is checked above.',
    }),
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
    el('p', {
      class: 'field-hint',
      text: 'Shows which shortcut fired, with a link to search for what you typed instead — but it holds the page for about 1.2 seconds every time, so it is off by default. Turn it on while you are learning the keywords.',
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
    'Address-bar interception',
    'Every keyword you own is intercepted in the address bar — if the first word of what you type is a shortcut, it runs, always. To search for those words instead, start the query with \\ or = (“=map of france”). Add a keyword here to exempt it permanently: an exempted keyword is skipped in the address bar but still works from bl + Tab and the toolbar popup.',
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
    if (list.length === 0) {
      chips.append(
        el('p', {
          class: 'field-hint',
          text: 'Nothing is exempt — every keyword is intercepted in the address bar.',
        }),
      );
      return;
    }
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
        { level: 'error', text: 'One keyword at a time — a keyword cannot contain a space.' },
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

export function renderAiTemplates(): HTMLElement {
  const card = panelCard(
    'AI prompt templates',
    'These prefill parameters are undocumented and providers change them. If one stops carrying your prompt, fix it here — no rebuild, no waiting.',
  );

  const list = el('div', { class: 'templates' });
  for (const provider of AI_PROVIDERS) {
    const input = textInput(
      getState().settings.aiTemplates[provider.id] ?? '',
      provider.template,
      true,
    );
    const warning = el('p', { class: 'msg msg-warn' });
    warning.hidden = true;

    const check = (): void => {
      const value = input.value.trim();
      warning.hidden = !value || value.includes('{q}');
      warning.textContent = 'Without {q} this template is ignored and the built-in one is used.';
    };
    input.addEventListener('input', check);
    input.addEventListener('change', () => {
      const value = input.value.trim();
      const aiTemplates = { ...getState().settings.aiTemplates };
      if (value) aiTemplates[provider.id] = value;
      else delete aiTemplates[provider.id];
      void commitSettings({ ...getState().settings, aiTemplates }, card.saved);
    });
    check();

    list.append(
      el('div', {
        class: 'field',
        children: [field(provider.label, input, `Default: ${provider.template}`), warning],
      }),
    );
  }

  card.body.append(list);
  return card.section;
}
