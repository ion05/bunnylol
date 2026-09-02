/**
 * The "Shortcuts" route: the filterable, grouped list of every shortcut there
 * is, shipped or user-created.
 *
 * `renderRow` is deliberately BRANCHLESS on where the shortcut came from. Every
 * row offers Edit, an on-off switch and Delete, because a shipped shortcut and
 * one the user typed in are the same kind of thing; the only thing that differs
 * is which override map Delete and Save write to, and that is decided inside
 * the handlers rather than by building two kinds of row.
 *
 * Every string that reaches the DOM goes through `textContent`: a shortcut name
 * is user input, and this view renders it next to the URL it will navigate to
 * (AGENTS.md invariant 11).
 */

import { BUILTIN_COMMANDS, destinationOf } from '../../lib/commands';
import { firstKey, sectionLabel, sectionOrder, shortcutId } from '../../lib/overrides';
import { activeKeywords, suggest } from '../../lib/resolve';
import { stripScheme } from '../../lib/text';
import type { Overrides, ShortcutEdit } from '../../lib/types';
import { el } from '../../ui/dom';
import { button, confirmButton, switchControl } from '../dom';
import { browseEntries, exampleOf, haystackOf } from '../model/browse';
import type { Entry } from '../model/browse';
import { go } from '../router';
import {
  commitOverrides,
  getCommands,
  getFilter,
  getState,
  reportFailure,
  setFilter,
  takeNotice,
} from '../store';

/** The one sentence the master plan fixes for a meta shortcut's Delete button:
 *  `bl`, `add` and `set` are deletable like everything else, and this says
 *  where they come back from and what still works while they are gone. */
const META_DELETE_TITLE =
  'Restore from Settings → Restore shipped shortcuts; the toolbar popup still opens this page.';

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
  row.dataset.id = entry.id;

  const keys = el('div', { class: 'row-keys' });
  for (const key of entry.cmd.keys) keys.append(el('code', { class: 'chip', text: key }));

  const name = el('div', { class: 'row-name', text: entry.cmd.name });
  if (entry.modified) {
    name.append(
      el('span', {
        class: 'badge badge-quiet badge-mod',
        text: 'modified',
        title:
          'Changed from the shipped definition. Open Edit, press Reset, then Save to put it back.',
      }),
    );
  }
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

  const remove = confirmButton('Delete', 'Click again to confirm', 'btn btn-sm btn-danger', () => {
    const overrides = getState().overrides;
    // A deleted shortcut is gone, not off, so it leaves `disabled` either way.
    const disabled = overrides.disabled.filter((id) => id !== entry.id);
    const next: Overrides = entry.shipped
      ? // `edits[id]` is deliberately KEPT: Restore brings back the shortcut
        // the user had, not the one the registry ships.
        { ...overrides, deleted: [...overrides.deleted, entry.id], disabled }
      : {
          ...overrides,
          custom: overrides.custom.filter((cmd) => shortcutId(cmd) !== entry.id),
          disabled,
          edits: withoutEdit(overrides.edits, entry.id),
        };
    void commitOverrides(next).catch(reportFailure);
    row.remove();
    onRemoved(row);
  });
  if (entry.cmd.handler === 'meta') remove.title = META_DELETE_TITLE;

  actions.append(
    button('Edit', () => go(`#edit?id=${encodeURIComponent(entry.id)}`), 'btn btn-sm'),
    switchControl(`Enable ${entry.cmd.name}`, !entry.disabled, (on) => {
      const next = getState().overrides.disabled.filter((id) => id !== entry.id);
      if (!on) next.push(entry.id);
      // Optimistic, and deliberately before the await: the switch has already
      // moved under the pointer, and a row that waits for storage to answer
      // reads as a control that did not take.
      row.classList.toggle('off', !on);
      offBadge.hidden = on;
      void commitOverrides({ ...getState().overrides, disabled: next }).catch(reportFailure);
    }),
    remove,
  );

  return row;
}

/** Null-prototype throughout: an id is a key off untrusted storage, and
 *  `edits['__proto__']` on a plain object is swallowed by the inherited
 *  setter. `edits` never holds a `u:` id today — `normalizeEdits` drops them —
 *  but a hand-edited import is exactly the file that would put one there. */
function withoutEdit(
  edits: Record<string, ShortcutEdit>,
  id: string,
): Record<string, ShortcutEdit> {
  const next: Record<string, ShortcutEdit> = Object.assign(Object.create(null), edits);
  delete next[id];
  return next;
}
