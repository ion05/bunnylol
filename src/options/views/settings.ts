/**
 * The "Settings" route: defaults, search interception, the address-bar
 * exemption list, AI prompt templates, and (via `renderData`) import/export.
 */

import { BUILTIN_COMMANDS, SEARCH_ENGINES } from '../../lib/commands';
import { AI_PROVIDERS } from '../../lib/handlers';
import {
  applyEdit,
  knownCategoryIds,
  restorableShipped,
  shortcutId,
} from '../../lib/overrides';
import type { SearchEngineId } from '../../lib/types';
import { DEFAULT_SETTINGS } from '../../lib/types';
import { el } from '../../ui/dom';
import {
  button,
  checkbox,
  errorField,
  field,
  flash,
  panelCard,
  selectControl,
  textInput,
} from '../dom';
import { buildKeyOwner, browseEntries } from '../model/browse';
import { engineProblem } from '../model/form';
import { getStatus, runtimeId, setSuppressedHost } from '../rule-status';
import {
  commitOverrides,
  commitSettings,
  getCommands,
  getState,
  reportFailure,
  stopSet,
} from '../store';
import { renderData } from './data';

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
