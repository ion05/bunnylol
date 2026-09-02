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
import { el, nextId } from '../../ui/dom';
import { button, confirmButton, iconButton, switchControl } from '../dom';
import { browseEntries, exampleOf, haystackOf } from '../model/browse';
import type { Entry } from '../model/browse';
import type { CollapseState } from '../model/collapse';
import { createCollapseState, groupExpanded, safeLocalStorage } from '../model/collapse';
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

/** Why a heading refuses to fold while the filter is live. */
const FOLD_LOCKED_TITLE = 'Clear the filter to fold groups';

interface RowRef {
  matchKey: string;
  haystack: string;
  order: number;
  node: HTMLElement;
}

interface GroupRef {
  /** The section id, which is what the collapsed state is remembered under. */
  id: string;
  node: HTMLElement;
  /** The disclosure button inside the heading; it owns `aria-expanded`. */
  toggle: HTMLElement;
  /** The element `toggle` controls — the only thing collapsing hides. */
  rowsHost: HTMLElement;
  count: HTMLElement;
  rows: RowRef[];
}

/**
 * Created once for the page rather than per render, and lazily so nothing
 * touches `localStorage` while this module is being imported. A fresh state per
 * render would be correct as long as the store works and would silently forget
 * every fold the moment it does not.
 */
let collapseState: CollapseState | null = null;

function collapse(): CollapseState {
  collapseState ??= createCollapseState(safeLocalStorage());
  return collapseState;
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
    const rows = el('div', { class: 'rows', id: nextId('rows') });
    // The contract's shape: `.group-head` is the heading that carries the
    // layout — the groups are this page's outline — and `.group-toggle` is the
    // button inside it. An h3, because the panel's own h2 is its parent in the
    // outline. The whole heading strip folds the group rather than a chevron
    // beside it: a 12px triangle is not a target, and the label is what the
    // user aims at.
    const toggle = el('button', {
      class: 'group-toggle',
      attrs: { type: 'button', 'aria-expanded': 'true', 'aria-controls': rows.id },
      children: [
        el('span', { class: 'group-chevron', attrs: { 'aria-hidden': 'true' } }),
        el('span', {
          class: 'group-title',
          text: sectionLabel(category, getState().overrides.sections),
        }),
        countNode,
      ],
    });
    const group = el('section', {
      class: 'group',
      children: [el('h3', { class: 'group-head', children: [toggle] }), rows],
    });

    toggle.addEventListener('click', () => {
      // Inert while a query is live, because `applyFilter` force-expands every
      // group then: the fold would be recorded and nothing on screen would
      // move, so the click would read as a control that did not take.
      if (filtering()) return;
      collapse().set(category, !collapse().isCollapsed(category));
      // The toggle records the intent and nothing else; `applyFilter` is the
      // only writer of what is on screen.
      applyFilter();
    });

    const ref: GroupRef = {
      id: category,
      node: group,
      toggle,
      rowsHost: rows,
      count: countNode,
      rows: [],
    };
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

  // A section id is minted from its label, so deleting `Client work` and making
  // another one by the same name mints `sec-client-work` again — and the fold
  // the first one left behind would land on the second as a group the user
  // never folded. Pruning to what was actually drawn, before anything reads the
  // state, is what stops a fold outliving the group it was about.
  collapse().prune(groupRefs.map((group) => group.id));

  const toolbarActions = el('div', {
    class: 'toolbar-actions',
    children: [
      button(
        'Collapse all',
        () => {
          collapse().collapseAll(groupRefs.map((group) => group.id));
          applyFilter();
        },
        'btn btn-sm btn-ghost',
      ),
      button(
        'Expand all',
        () => {
          collapse().expandAll();
          applyFilter();
        },
        'btn btn-sm btn-ghost',
      ),
    ],
  });

  // The head the approved artboard gives this route. It is written out here
  // rather than built with `panelCard()` because this panel has nothing to
  // flash "Saved" into: every write it makes leaves through the notice above.
  const head = el('div', {
    class: 'panel-head',
    children: [
      // `.panel-head-text` is the same wrapper `panelCard()` builds, so both
      // heads are one element tree and one rule styles them.
      el('div', {
        class: 'panel-head-text',
        children: [
          el('h2', { class: 'panel-title', text: 'Shortcuts' }),
          el('p', {
            class: 'panel-sub',
            text: 'Type a keyword in the address bar. Anything after it is passed along as a query. Every shortcut here can be edited, moved to another section, switched off or deleted.',
          }),
        ],
      }),
    ],
  });

  const panel = el('section', {
    class: 'panel',
    children: [
      head,
      el('div', {
        class: 'panel-body',
        children: [
          el('div', {
            class: 'toolbar',
            children: [
              el('div', { class: 'search-field', children: [filter] }),
              count,
              toolbarActions,
            ],
          }),
          groups,
          empty,
        ],
      }),
    ],
  });

  /** Whether a query is live. The fold is not writable while one is: see
   *  `groupExpanded`. */
  function filtering(): boolean {
    return filter.value.trim() !== '';
  }

  function applyFilter(): void {
    const query = filter.value.trim().toLowerCase();
    setFilter(filter.value);
    // Collapse all / Expand all would record a fold nothing shows, so they are
    // not offered while a query is live. `applyFilter` is the single writer of
    // this too, so there is one place the filter's effect on the page is
    // decided.
    toolbarActions.hidden = query !== '';

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
      // The one place `rowsHost.hidden` is written, for the same reason
      // `row.hidden` is written only here: the filter and the fold both decide
      // it, and two writers would race whenever a query was typed into a
      // folded group.
      const expanded = groupExpanded(query, collapse().isCollapsed(group.id));
      group.rowsHost.hidden = !expanded;
      group.toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      // `aria-disabled` rather than `disabled`: the heading stays in the tab
      // order and keeps its accessible name, so a keyboard user reading down
      // the list is told why it will not fold instead of skipping past it.
      if (query) {
        group.toggle.setAttribute('aria-disabled', 'true');
        group.toggle.title = FOLD_LOCKED_TITLE;
      } else {
        group.toggle.removeAttribute('aria-disabled');
        group.toggle.removeAttribute('title');
      }
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
        class: 'badge badge-quiet',
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

  const remove = confirmButton(
    `Delete ${entry.cmd.name}`,
    'Click again to delete',
    'btn btn-sm btn-ghost btn-icon',
    () => {
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
    },
    'trash',
    entry.cmd.handler === 'meta' ? META_DELETE_TITLE : '',
  );

  // Edit, Delete, then the switch: the two actions that open or remove the row
  // sit together, and the state control stays at the edge where it is always
  // visible.
  actions.append(
    iconButton(`Edit ${entry.cmd.name}`, 'pencil', () => {
      go(`#edit?id=${encodeURIComponent(entry.id)}`);
    }),
    remove,
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
