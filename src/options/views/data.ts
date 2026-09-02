/**
 * The "Data" card in Settings: export, import (merge or replace), and reset.
 */

import { BUILTIN_COMMANDS } from '../../lib/commands';
import { mergeOverrides } from '../../lib/merge-import';
import { MAX_SECTIONS, shortcutId } from '../../lib/overrides';
import type { ImportedState } from '../../lib/storage';
import { applyImport, exportJson, importJson } from '../../lib/storage';
import { clone, countShipped, errorText, joinClauses } from '../../lib/text';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS } from '../../lib/types';
import { el } from '../../ui/dom';
import { button, confirmButton, panelCard } from '../dom';
import { go } from '../router';
import { commitState, getCommands, getState, setNotice } from '../store';

export function renderData(): HTMLElement {
  const card = panelCard(
    'Data',
    'The export holds your shortcuts, your edits, your sections and your settings. It does not hold the built-in list, so an old file still works after an update.',
  );

  const error = el('p', { class: 'msg msg-error', attrs: { role: 'alert' } });
  error.hidden = true;

  // `hidden` rather than `.visually-hidden`: a 1x1px input is still a focus
  // stop, and this one exists only to be `click()`ed.
  const fileInput = el('input', {
    attrs: {
      type: 'file',
      accept: 'application/json,.json',
      tabindex: '-1',
      'aria-hidden': 'true',
    },
  });
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => void handleImport());

  const choice = el('div', {
    class: 'import-choice',
    attrs: { role: 'group', 'aria-label': 'Confirm import' },
  });
  choice.hidden = true;

  const closeChoice = (): void => {
    choice.textContent = '';
    choice.hidden = true;
  };

  async function handleImport(): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file) return;
    error.hidden = true;
    closeChoice();
    try {
      // Parse before anything is touched: the confirmation is only honest if it
      // can name what the file actually contains.
      askImport(file.name, importJson(await file.text()));
    } catch (err) {
      error.textContent = errorText(err);
      error.hidden = false;
    } finally {
      fileInput.value = '';
    }
  }

  function askImport(fileName: string, imported: ImportedState): void {
    const mine = getState().overrides.custom.length;
    const theirs = imported.overrides.custom.length;
    const plan = mergeOverrides(getState().overrides, imported.overrides);

    const lines: string[] = [
      `${fileName} holds ${countShortcuts(theirs)}. You have ${countShortcuts(mine)}.`,
      `Merge keeps yours and adds ${countShortcuts(plan.added.length)}, leaving your settings alone.`,
      imported.settings
        ? `Replace deletes your ${countShortcuts(mine)} and your settings, leaving only what is in ${fileName}.`
        : `Replace deletes your ${countShortcuts(mine)}, leaving only what is in ${fileName}. That file carries no settings, so yours stay as they are.`,
    ];
    if (plan.renames.length > 0) {
      const renamed = plan.renames.map((rename) => `${rename.from} → ${rename.to}`).join(', ');
      lines.push(`Merge renames the keywords you already use: ${renamed}.`);
    }
    if (plan.duplicates.length > 0) {
      lines.push(`Already identical to yours, so merge skips them: ${plan.duplicates.join(', ')}.`);
    }
    // Four clauses in one sentence is where "Merge also a, b, c and d." stops
    // being readable, so the shortcut-level changes and the section-level ones
    // are separate sentences and the undo for a delete is its own.
    const also: string[] = [];
    if (plan.disables.length > 0) {
      also.push(
        `turns off ${countShipped(plan.disables.length)} (${shortcutNames(plan.disables)})`,
      );
    }
    if (plan.deletes.length > 0) {
      also.push(`deletes ${countShipped(plan.deletes.length)} (${shortcutNames(plan.deletes)})`);
    }
    if (plan.rebinds.length > 0) {
      const n = plan.rebinds.length;
      const noun = n === 1 ? 'keyword' : 'keywords';
      also.push(`rebinds the ${noun} of ${countShipped(n)} (${shortcutNames(plan.rebinds)})`);
    }
    if (plan.edits.length > 0) {
      also.push(`changes ${countShipped(plan.edits.length)} (${shortcutNames(plan.edits)})`);
    }
    if (also.length > 0) lines.push(`Merge also ${joinClauses(also)}.`);
    if (plan.deletes.length > 0) {
      lines.push(
        'Anything it deletes comes back from Settings → Restore shipped shortcuts, so nothing is lost for good.',
      );
    }

    const sections: string[] = [];
    if (plan.sections.length > 0) {
      const n = plan.sections.length;
      const names = nameList(plan.sections.map((section) => section.label));
      sections.push(`adds ${n} ${n === 1 ? 'section' : 'sections'} (${names})`);
    }
    if (plan.sectionsRefused.length > 0) {
      const n = plan.sectionsRefused.length;
      const names = nameList(plan.sectionsRefused.map((section) => section.label));
      const noun = n === 1 ? 'section' : 'sections';
      sections.push(
        `leaves out ${n} ${noun} (${names}) because you already have the ${MAX_SECTIONS} BunnyLol keeps`,
      );
    }
    if (sections.length > 0) lines.push(`Merge ${joinClauses(sections)}.`);
    lines.push('Either way, your current setup is exported to your downloads folder first.');

    const done = (text: string): void => {
      setNotice({ tone: 'ok', text });
      go('#help');
    };
    const fail = (err: unknown): void => {
      closeChoice();
      error.textContent = errorText(err);
      error.hidden = false;
    };

    const merge = (): void => {
      backupState();
      commitState({ overrides: plan.overrides, settings: getState().settings }).then(
        () =>
          done(
            plan.added.length === 0
              ? `Nothing new in ${fileName}. Your shortcuts already cover it.`
              : `Merged ${countShortcuts(plan.added.length)} from ${fileName}.`,
          ),
        fail,
      );
    };
    const replace = (): void => {
      backupState();
      commitState(applyImport(imported, getState())).then(
        () => done(`Replaced everything with ${countShortcuts(theirs)} from ${fileName}.`),
        fail,
      );
    };

    choice.textContent = '';
    choice.append(
      el('h3', { class: 'import-title', text: `Import ${fileName}?` }),
      ...lines.map((text) => el('p', { class: 'import-line', text })),
      el('div', {
        class: 'btn-row',
        children: [
          button('Merge', merge, 'btn btn-primary'),
          button('Replace everything', replace, 'btn btn-danger'),
          button('Cancel', closeChoice, 'btn btn-ghost'),
        ],
      }),
    );
    choice.hidden = false;
    choice.querySelector('button')?.focus();
  }

  card.body.append(
    el('div', {
      class: 'btn-row',
      children: [
        button('Export JSON', () => exportState(), 'btn'),
        button('Import JSON…', () => fileInput.click(), 'btn'),
        fileInput,
      ],
    }),
    choice,
    error,
    el('div', {
      class: 'danger-zone',
      children: [
        el('p', {
          text: 'Reset deletes every shortcut you made, restores every shipped shortcut you turned off or deleted, forgets your sections and puts settings back to their defaults.',
        }),
        confirmButton('Reset to defaults', 'Click again to reset', 'btn btn-danger', () => {
          const defaults = { overrides: clone(DEFAULT_OVERRIDES), settings: clone(DEFAULT_SETTINGS) };
          commitState(defaults).then(
            () => {
              setNotice({ tone: 'ok', text: 'Everything is back to defaults.' });
              go('#help');
            },
            (err: unknown) => {
              error.textContent = errorText(err);
              error.hidden = false;
            },
          );
        }),
      ],
    }),
  );
  return card.section;
}

export function exportState(name = 'bunnylol-shortcuts.json'): void {
  const blob = new Blob([exportJson(getState())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { class: 'visually-hidden' });
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can race the download in Chromium.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Written before any import overwrites anything, so "undo" is a file. */
export function backupState(): void {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  exportState(`bunnylol-backup-${stamp}.json`);
}

export function countShortcuts(n: number): string {
  return `${n} ${n === 1 ? 'shortcut' : 'shortcuts'}`;
}

const SHIPPED_NAMES = new Map(BUILTIN_COMMANDS.map((cmd) => [shortcutId(cmd), cmd.name]));

/**
 * The names of the shortcuts an id list points at, never the ids themselves.
 * A shipped id is a slug the user has never seen: a dialog that says it is
 * about to delete `gpulls` is asking them to approve something they cannot
 * recognise, while the row it is about reads "GitHub pull requests".
 *
 * Named as they are HERE: the merged list first, so a shortcut the user renamed
 * is called what their own browse page calls it, then the registry for one that
 * is off, and only then the id: for an export from a later version naming a
 * command this build does not have.
 */
function shortcutNames(ids: string[]): string {
  const live = new Map(getCommands().map((cmd) => [shortcutId(cmd), cmd.name]));
  return nameList(ids.map((id) => live.get(id) ?? SHIPPED_NAMES.get(id) ?? id));
}

/** A list long enough to be trustworthy without being the whole catalogue. */
export function nameList(items: string[], limit = 6): string {
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')}, +${items.length - limit} more`;
}
