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
 * A switched-off shortcut is NOT drawn in its section. It is drawn last on the
 * page, under one folded "Hidden shortcuts" heading, so a user who declined
 * three packs on the welcome picker sees a shorter page rather than a page of
 * dead rows. The section groups and their counts are therefore about live
 * shortcuts only, and the switch moves a row between the two places.
 *
 * Every string that reaches the DOM goes through `textContent`: a shortcut name
 * is user input, and this view renders it next to the URL it will navigate to
 * (AGENTS.md invariant 11).
 */

import { BUILTIN_COMMANDS, destinationOf } from '../../lib/commands';
import { firstKey, shortcutId } from '../../lib/overrides';
import { activeKeywords, suggest } from '../../lib/resolve';
import { stripScheme } from '../../lib/text';
import type { Overrides, ShortcutEdit } from '../../lib/types';
import { el, nextId } from '../../ui/dom';
import { button, confirmButton, iconButton, switchControl } from '../dom';
import {
  browseEntries,
  browseGroups,
  countLabel,
  exampleOf,
  haystackOf,
  HIDDEN_GROUP_ID,
} from '../model/browse';
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

/** The one sentence a meta shortcut's Delete button adds: `bl`, `add` and `set`
 *  are deletable like everything else, and deleting one is worth a word because
 *  it reads as though it takes the options page with it. It does not, and this
 *  says so without promising the keyword itself comes back. */
const META_DELETE_TITLE = 'The toolbar popup still opens this page without this keyword.';

/** The group every switched-off shortcut is drawn under, last on the page. */
const HIDDEN_TITLE = 'Hidden shortcuts';

/** One sentence, under the heading rather than inside the fold, because the
 *  group is folded by default and the question it answers is asked by the
 *  heading being there at all. */
const HIDDEN_NOTE =
  'Shortcuts you switched off, plus the shipped packs you did not turn on: switch one back on to put it in its section.';

/** Why a heading refuses to fold while the filter is live. */
const FOLD_LOCKED_TITLE = 'Clear the filter to fold groups';

interface RowRef {
  matchKey: string;
  haystack: string;
  order: number;
  node: HTMLElement;
  /** The section group this row belongs to whenever it is switched on. A
   *  switched-off row is drawn under "Hidden shortcuts" and still remembers
   *  this, because that is where switching it back on has to return it. */
  home: GroupRef;
  /** The group the row is drawn in right now: `home`, or the hidden group. */
  group: GroupRef;
}

interface GroupRef {
  /** The section id, which is what the collapsed state is remembered under. */
  id: string;
  node: HTMLElement;
  /** The disclosure button inside the heading; it owns `aria-expanded`. */
  toggle: HTMLElement;
  /** The element `toggle` controls: the only thing collapsing hides. */
  rowsHost: HTMLElement;
  count: HTMLElement;
  /** Reassigned as rows move between groups, so it is always the rows this
   *  group actually holds. */
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
  // "Hidden shortcuts" is the one group that starts folded: a user who declined
  // three packs on the picker would otherwise land on a page of switched-off
  // rows, which is the thing this group exists to get out of the way.
  collapseState ??= createCollapseState(safeLocalStorage(), [HIDDEN_GROUP_ID]);
  return collapseState;
}

/**
 * Forgets every fold, for a reset that is putting the profile back to how it
 * was installed. It goes through the same state the page folds with, rather
 * than clearing `localStorage` from the outside: the singleton above outlives
 * a reset, so a cleared store alone would leave the old set in memory and the
 * next fold would write all of it back.
 */
export function forgetCollapsed(): void {
  collapse().expandAll();
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

  // Built on every render, whether or not anything is switched off, and hidden
  // by `applyFilter` when it holds no rows: exactly what already happens to a
  // section whose rows the filter took away. Building it on demand instead
  // would put a second decider of whether a group is on screen inside the
  // switch handler, next to the one that is supposed to be the only one.
  const hiddenGroup = makeGroup(HIDDEN_GROUP_ID, HIDDEN_TITLE, HIDDEN_NOTE);
  const anyHidden = entries.some((entry) => entry.disabled);

  // One counter across every section rather than an index per group, because a
  // row's `order` also has to sort it inside the hidden group, where rows from
  // several sections meet. Counting through the sections in order keeps them
  // together there.
  let position = 0;
  for (const section of browseGroups(entries, getState().overrides.sections)) {
    const home = makeGroup(section.id, section.label);
    for (const entry of section.entries) {
      // Declared before the row so the switch can close over it. The handler
      // only ever runs from a click, long after the assignment below.
      let ref: RowRef;
      const node = renderRow(
        entry,
        intercepted,
        (deleted) => {
          removed.add(deleted);
          applyFilter();
        },
        // Moving the one node the switch is about, rather than re-rendering
        // the view. A re-render would be correct, `commitOverrides` applies the
        // new state before it awaits storage, but it would repaint ~170 rows
        // for a one-row change and throw away the control the user is still
        // touching. Moving parentage keeps `applyFilter` the only thing that
        // writes `row.hidden` and `rowsHost.hidden`: it runs straight after and
        // decides the counts, the two headings and what is on screen.
        (on) => {
          move(ref, on ? ref.home : hiddenGroup);
          applyFilter();
        },
      );
      ref = {
        matchKey: entry.matchKey,
        haystack: haystackOf(entry.cmd),
        order: position++,
        node,
        home,
        group: home,
      };
      place(ref, entry.disabled ? hiddenGroup : home);
    }
    groupRefs.push(home);
    groups.append(home.node);
  }

  // Last, after every section: a pack the user declined is meant to be out of
  // the way, not a dead stretch in the middle of the list.
  groupRefs.push(hiddenGroup);
  groups.append(hiddenGroup.node);

  // A section id is minted from its label, so deleting `Client work` and making
  // another one by the same name mints `sec-client-work` again, and the fold
  // the first one left behind would land on the second as a group the user
  // never folded. Pruning to what was actually drawn, before anything reads the
  // state, is what stops a fold outliving the group it was about. The hidden
  // group counts as drawn only while something is in it, so a profile that
  // switches its last hidden shortcut back on gets the folded default again
  // when the group next appears.
  collapse().prune(
    groupRefs.filter((group) => group !== hiddenGroup || anyHidden).map((group) => group.id),
  );

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
    let visibleOn = 0;
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
      // A bare number on every heading, the hidden group included: which group
      // a row is in is now the whole of what "off" means, so no heading has a
      // mixture to describe.
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
      // Which group the row sits in IS its on-off state, so nothing here has to
      // read a class back off a row to find out.
      if (group !== hiddenGroup) visibleOn += inGroup;
    }

    count.textContent = countLabel({ on: visibleOn, shown: visible, total }, query !== '');

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

  /**
   * A group heading, its disclosure and the host its rows live in. Sections and
   * "Hidden shortcuts" are built by the same function on purpose: Collapse all,
   * Expand all and the fold-locked-while-filtering rule are written once, and
   * the hidden group cannot drift into being a special case of them.
   */
  function makeGroup(id: string, title: string, note?: string): GroupRef {
    // Left empty: `applyFilter` writes every count, and a number rendered here
    // would be the one thing on the page that had not been through it.
    const countNode = el('span', { class: 'group-count' });
    const rows = el('div', { class: 'rows', id: nextId('rows') });
    // The contract's shape: `.group-head` is the heading that carries the
    // layout, the groups are this page's outline, and `.group-toggle` is the
    // button inside it. An h3, because the panel's own h2 is its parent in the
    // outline. The whole heading strip folds the group rather than a chevron
    // beside it: a 12px triangle is not a target, and the label is what the
    // user aims at.
    const toggle = el('button', {
      class: 'group-toggle',
      attrs: { type: 'button', 'aria-expanded': 'true', 'aria-controls': rows.id },
      children: [
        el('span', { class: 'group-chevron', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'group-title', text: title }),
        countNode,
      ],
    });
    const children: Node[] = [el('h3', { class: 'group-head', children: [toggle] })];
    // Outside the rows host, so it is still readable with the group folded,
    // which is how the hidden group starts.
    if (note) children.push(el('p', { class: 'group-note', text: note }));
    children.push(rows);
    const group = el('section', { class: 'group', children });

    toggle.addEventListener('click', () => {
      // Inert while a query is live, because `applyFilter` force-expands every
      // group then: the fold would be recorded and nothing on screen would
      // move, so the click would read as a control that did not take.
      if (filtering()) return;
      collapse().set(id, !collapse().isCollapsed(id));
      // The toggle records the intent and nothing else; `applyFilter` is the
      // only writer of what is on screen.
      applyFilter();
    });

    return { id, node: group, toggle, rowsHost: rows, count: countNode, rows: [] };
  }

  /** Files a row under a group: the row's node, the group's list and the row's
   *  idea of where it is, written in one place so they cannot disagree. */
  function place(ref: RowRef, to: GroupRef): void {
    ref.group = to;
    to.rows.push(ref);
    to.rowsHost.append(ref.node);
  }

  function move(ref: RowRef, to: GroupRef): void {
    if (ref.group === to) return;
    // `append` on a node that is already in the document is a removal and an
    // insertion, and removing the focused element sends focus to the body. A
    // keyboard user who pressed Space on the switch would lose their place, so
    // the focus is put back. `preventScroll`, because the row has just moved to
    // the bottom of the page and refocusing it would drag the page after it.
    const focused = ref.node.contains(document.activeElement) ? document.activeElement : null;
    ref.group.rows = ref.group.rows.filter((row) => row !== ref);
    place(ref, to);
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
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
  onToggled: (on: boolean) => void,
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
  // No "off" badge: a switched-off row is drawn under the "Hidden shortcuts"
  // heading, which says the same thing once for the whole group. The dimming
  // stays, so a row on its way between the two groups still does not read like
  // a live one the moment the switch moves.
  if (!entry.disabled && !entry.cmd.keys.some((key) => intercepted.has(key))) {
    const marker = el('span', { class: 'badge badge-quiet', text: 'omnibox only' });
    marker.title =
      'Not intercepted in the address bar. Type bl, press Tab, then the keyword, or use the popup.';
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
      // Moves the row between its section and "Hidden shortcuts", and repaints
      // the counts on both headings.
      onToggled(on);
      void commitOverrides({ ...getState().overrides, disabled: next }).catch(reportFailure);
    }),
  );

  return row;
}

/** Null-prototype throughout: an id is a key off untrusted storage, and
 *  `edits['__proto__']` on a plain object is swallowed by the inherited
 *  setter. `edits` never holds a `u:` id today, `normalizeEdits` drops them,
 *  but a hand-edited import is exactly the file that would put one there. */
function withoutEdit(
  edits: Record<string, ShortcutEdit>,
  id: string,
): Record<string, ShortcutEdit> {
  const next: Record<string, ShortcutEdit> = Object.assign(Object.create(null), edits);
  delete next[id];
  return next;
}
