/**
 * The "Shortcuts" route: the filterable, grouped list of every builtin plus
 * every custom command, and the inline rebind editor for a builtin's keys.
 *
 * Every string that reaches the DOM goes through `textContent`: a shortcut name
 * is user input, and this view renders it next to the URL it will navigate to
 * (AGENTS.md invariant 11).
 */

import { BUILTIN_COMMANDS, destinationOf } from '../../lib/commands';
import { parseKeys } from '../../lib/draft';
import { firstKey, sectionLabel, sectionOrder, shortcutId } from '../../lib/overrides';
import { activeKeywords, suggest } from '../../lib/resolve';
import { stripScheme } from '../../lib/text';
import { isInterceptableAlias } from '../../lib/validate';
import { el, nextId } from '../../ui/dom';
import { button, confirmButton, switchControl } from '../dom';
import {
  buildKeyOwner,
  browseEntries,
  describeOwner,
  exampleOf,
  haystackOf,
} from '../model/browse';
import type { Entry } from '../model/browse';
import { go } from '../router';
import {
  commitOverrides,
  getCommands,
  getFilter,
  getState,
  reportFailure,
  setFilter,
  stopSet,
  takeNotice,
} from '../store';

interface RowRef {
  matchKey: string;
  haystack: string;
  order: number;
  node: HTMLElement;
}

interface GroupRef {
  node: HTMLElement;
  count: HTMLElement;
  rows: RowRef[];
}

export function renderBrowse(): Node[] {
  const entries = browseEntries(BUILTIN_COMMANDS, getState().overrides);
  // The same list the DNR rules are built from, so the marker below cannot
  // drift from what the address bar actually does.
  const intercepted = new Set(activeKeywords(getCommands(), getState().settings.interceptStopList));
  const nodes: Node[] = [];

  const shown = takeNotice();
  // A stale filter would hide the very shortcut the notice is about.
  if (shown) setFilter('');
  if (shown) {
    nodes.push(
      el('div', {
        class: 'panel',
        children: [
          el('div', {
            class: 'panel-body',
            children: [
              el('p', {
                class: shown.tone === 'ok' ? 'msg msg-ok' : 'msg msg-error',
                text: shown.text,
                attrs: { role: 'status' },
              }),
            ],
          }),
        ],
      }),
    );
  }

  const filter = el('input', {
    class: 'input',
    id: 'filter',
    attrs: {
      type: 'search',
      placeholder: 'Filter by keyword, name or description…   (press /)',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Filter shortcuts',
    },
  });
  filter.value = getFilter();

  const count = el('p', { class: 'count', attrs: { role: 'status', 'aria-live': 'polite' } });
  const groups = el('div', { class: 'groups' });
  const empty = el('div', { class: 'empty' });
  empty.hidden = true;

  const groupRefs: GroupRef[] = [];
  /** Rows whose shortcut was deleted; their nodes are gone from the DOM but
   *  they are still listed in `groupRefs`, and the counts must skip them. */
  const removed = new WeakSet<HTMLElement>();

  const order = sectionOrder(
    getState().overrides.sections,
    entries.map((entry) => entry.cmd),
  );
  for (const category of order) {
    const inGroup = entries.filter((entry) => entry.cmd.category === category);
    if (inGroup.length === 0) continue;

    const countNode = el('span', { class: 'group-count', text: String(inGroup.length) });
    const rows = el('div', { class: 'rows' });
    const group = el('section', {
      class: 'group',
      children: [
        el('div', {
          class: 'group-head',
          children: [
            el('h2', {
              class: 'group-title',
              text: sectionLabel(category, getState().overrides.sections),
            }),
            countNode,
          ],
        }),
        rows,
      ],
    });

    const ref: GroupRef = { node: group, count: countNode, rows: [] };
    inGroup.forEach((entry, index) => {
      const node = renderRow(entry, intercepted, (deleted) => {
        removed.add(deleted);
        applyFilter();
      });
      rows.append(node);
      ref.rows.push({
        matchKey: entry.matchKey,
        haystack: haystackOf(entry.cmd),
        order: index,
        node,
      });
    });
    groupRefs.push(ref);
    groups.append(group);
  }

  const panel = el('section', {
    class: 'panel',
    children: [
      el('div', {
        class: 'toolbar',
        children: [el('div', { class: 'search-field', children: [filter] }), count],
      }),
      groups,
      empty,
    ],
  });

  function applyFilter(): void {
    const query = filter.value.trim().toLowerCase();
    setFilter(filter.value);

    // `suggest()` gives keyword-first ranking; the substring pass then widens it
    // to descriptions so the box behaves like a filter and not just a launcher.
    const ranks = new Map<string, number>();
    if (query) {
      suggest(query, getCommands(), getCommands().length).forEach((cmd, index) => {
        const key = firstKey(cmd);
        if (!ranks.has(key)) ranks.set(key, index);
      });
    }

    let visible = 0;
    let total = 0;
    for (const group of groupRefs) {
      let inGroup = 0;
      for (const row of group.rows) {
        if (removed.has(row.node)) continue;
        total += 1;
        const rank = ranks.get(row.matchKey);
        const match = !query || rank !== undefined || row.haystack.includes(query);
        row.node.hidden = !match;
        // Reordering with `order` keeps the DOM untouched, so filtering ~170
        // rows costs a style recalc instead of a re-render.
        row.node.style.order = String(rank ?? (query ? 10000 + row.order : row.order));
        if (match) inGroup += 1;
      }
      group.count.textContent = String(inGroup);
      group.node.hidden = inGroup === 0;
      visible += inGroup;
    }

    count.textContent = query ? `${visible} of ${total} shortcuts` : `${total} shortcuts`;

    empty.textContent = '';
    empty.hidden = visible > 0;
    if (visible === 0) {
      empty.append(
        el('p', { text: `Nothing matches “${filter.value.trim()}”.` }),
        el('div', {
          class: 'btn-row',
          children: [
            button(
              'Create a shortcut for it',
              () => go(`#new?prefill=${encodeURIComponent(filter.value.trim())}`),
              'btn btn-primary btn-sm',
            ),
          ],
        }),
      );
    }
  }

  filter.addEventListener('input', applyFilter);
  applyFilter();

  nodes.push(panel);
  return nodes;
}

function renderRow(
  entry: Entry,
  intercepted: Set<string>,
  onRemoved: (row: HTMLElement) => void,
): HTMLElement {
  const row = el('div', { class: entry.disabled ? 'row off' : 'row' });

  const keys = el('div', { class: 'row-keys' });
  const paintKeys = (list: string[]): void => {
    keys.textContent = '';
    for (const key of list) keys.append(el('code', { class: 'chip', text: key }));
  };
  paintKeys(entry.cmd.keys);

  const name = el('div', { class: 'row-name', text: entry.cmd.name });
  if (!entry.cmd.builtin) name.append(el('span', { class: 'badge', text: 'yours' }));
  // The row is dimmed rather than greyed out, so the off state needs a label
  // that does not depend on noticing a colour.
  const offBadge = el('span', { class: 'badge badge-quiet', text: 'off' });
  offBadge.title = 'Turned off. It resolves nowhere until you switch it back on.';
  offBadge.hidden = !entry.disabled;
  name.append(offBadge);
  if (!entry.disabled && !entry.cmd.keys.some((key) => intercepted.has(key))) {
    const marker = el('span', { class: 'badge badge-quiet', text: 'omnibox only' });
    marker.title =
      'Not intercepted in the address bar. Type bl, press Tab, then the keyword — or use the popup.';
    name.append(marker);
  }

  const body = el('div', {
    class: 'row-body',
    children: [name, el('div', { class: 'row-desc', text: entry.cmd.description })],
  });
  const destination = destinationOf(entry.cmd);
  body.append(
    el('div', { class: 'row-url', text: stripScheme(destination), title: destination }),
  );
  const example = exampleOf(entry.cmd);
  if (example) body.append(el('div', { class: 'row-example', text: example }));

  const actions = el('div', { class: 'row-actions' });
  row.append(keys, body, actions);

  if (entry.cmd.builtin) {
    // Built on demand: pre-rendering a hidden rebind form under every one of
    // ~170 rows is a lot of DOM for a control most rows never open.
    let editor: HTMLElement | null = null;
    actions.append(
      button('Keys', () => {
        if (editor) editor.hidden = !editor.hidden;
        else {
          editor = renderKeyEditor(entry, row, paintKeys);
          row.append(editor);
        }
        const open: HTMLElement = editor;
        if (!open.hidden) open.querySelector('input')?.focus();
      }, 'btn btn-sm btn-ghost'),
      switchControl(`Enable ${entry.cmd.name}`, !entry.disabled, (on) => {
        const next = getState().overrides.disabled.filter((key) => key !== entry.id);
        if (!on) next.push(entry.id);
        row.classList.toggle('off', !on);
        offBadge.hidden = on;
        void commitOverrides({ ...getState().overrides, disabled: next }).catch(reportFailure);
      }),
    );
  } else {
    actions.append(
      button('Edit', () => go(`#edit?key=${encodeURIComponent(entry.id)}`), 'btn btn-sm'),
      confirmButton('Delete', 'Click again to confirm', 'btn btn-sm btn-danger', () => {
        const custom = getState().overrides.custom.filter((cmd) => shortcutId(cmd) !== entry.id);
        void commitOverrides({ ...getState().overrides, custom }).catch(reportFailure);
        row.remove();
        onRemoved(row);
      }),
    );
  }

  return row;
}

/** Rebinding a builtin writes `edits[id].keys`; the builtin itself is never
 *  mutated, so "Reset" is just dropping that one field. */
function renderKeyEditor(
  entry: Entry,
  row: HTMLElement,
  paintKeys: (keys: string[]) => void,
): HTMLElement {
  const input = el('input', {
    class: 'input mono',
    attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off' },
  });
  input.value = entry.cmd.keys.join(', ');
  const label = el('label', {
    class: 'visually-hidden',
    text: `Keywords for ${entry.cmd.name}`,
  });
  label.htmlFor = input.id || (input.id = nextId('keys'));

  const message = el('span', { class: 'msg msg-error' });
  message.hidden = true;
  const warning = el('span', { class: 'msg msg-warn' });
  warning.hidden = true;

  const editor = el('div', { class: 'row-editor' });

  // Cancel and Escape have to agree: leaving the edited text in the box after
  // Cancel reads as "saved" the next time the editor is opened.
  const close = (): void => {
    input.value = entry.cmd.keys.join(', ');
    editor.hidden = true;
    message.hidden = true;
    warning.hidden = true;
  };

  const fail = (text: string): void => {
    message.textContent = text;
    message.hidden = false;
    // A warning from a previous save reads as the outcome of this one.
    warning.hidden = true;
  };

  const save = (): void => {
    // The same validator the new-shortcut form and the import path use. An
    // alias it rejects is unreachable from every surface, not merely
    // un-intercepted, so it must not be saved at all.
    const parsed = parseKeys(input.value);
    if (!parsed.ok) return fail(parsed.reason);

    const keys = parsed.keys;
    if (keys.length === 0) {
      return fail('Enter at least one keyword, or use Reset to restore the default.');
    }
    const entries = browseEntries(BUILTIN_COMMANDS, getState().overrides);
    const owners = buildKeyOwner(entries);
    const clash = keys.find((key) => {
      const owner = owners.get(key);
      return owner !== undefined && owner !== entry.id;
    });
    if (clash) {
      return fail(
        `“${clash}” is already taken by ${describeOwner(entries, owners.get(clash) ?? '')}.`,
      );
    }

    const edits = {
      ...getState().overrides.edits,
      [entry.id]: { ...getState().overrides.edits[entry.id], keys },
    };
    entry.cmd = { ...entry.cmd, keys };
    entry.matchKey = keys[0];
    paintKeys(keys);
    reset.hidden = false;
    void commitOverrides({ ...getState().overrides, edits }).catch(reportFailure);

    // Non-blocking, and the same copy `validate()` uses: the rebind is saved
    // and the keyword resolves everywhere the resolver runs; it is only the
    // address-bar redirect that cannot carry it. Leaving the editor open is
    // what makes the warning visible at all.
    const blocked = keys.filter((key) => !isInterceptableAlias(key) || stopSet().has(key));
    if (blocked.length > 0) {
      warning.textContent = `Saved, but “${blocked.join('”, “')}” ${blocked.length === 1 ? 'is' : 'are'} not intercepted in the address bar — typing ${blocked.length === 1 ? 'it' : 'them'} there runs a normal search. ${blocked.length === 1 ? 'It still works' : 'They still work'} from the toolbar popup and from bl + Tab.`;
      warning.hidden = false;
      message.hidden = true;
      return;
    }
    close();
    row.querySelector<HTMLButtonElement>('.row-actions .btn')?.focus();
  };

  const reset = button('Reset', () => {
    const edits = { ...getState().overrides.edits };
    // Only the keys: this button restores the shipped keywords, and dropping
    // the whole entry would silently discard edits to the other fields.
    const { keys: _dropped, ...rest } = edits[entry.id] ?? {};
    if (Object.keys(rest).length > 0) edits[entry.id] = rest;
    else delete edits[entry.id];
    const original = BUILTIN_COMMANDS.find((cmd) => shortcutId(cmd) === entry.id)?.keys ?? entry.cmd.keys;
    entry.cmd = { ...entry.cmd, keys: original };
    entry.matchKey = (original[0] ?? entry.id).toLowerCase();
    input.value = original.join(', ');
    paintKeys(original);
    void commitOverrides({ ...getState().overrides, edits }).catch(reportFailure);
    close();
  }, 'btn btn-sm');
  reset.hidden = !getState().overrides.edits[entry.id]?.keys?.length;

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });

  editor.append(
    label,
    input,
    button('Save keywords', save, 'btn btn-sm btn-primary'),
    reset,
    button('Cancel', close, 'btn btn-sm btn-ghost'),
    message,
    warning,
  );
  return editor;
}
