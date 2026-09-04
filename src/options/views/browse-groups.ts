/**
 * The browse list's skeleton: the group headings, the runs inside "Hidden
 * shortcuts", and the bookkeeping that files a row under one group or another.
 *
 * NOTHING IN THIS FILE WRITES WHAT IS ON SCREEN. No `row.hidden`, no
 * `rowsHost.hidden`, no count, no badge, no wording on any of the controls it
 * builds. Every one of those is written by `applyFilter` in `views/browse.ts`,
 * and that is the whole reason this file exists as a file: the contract is a
 * grep over two short modules rather than a reading of one long closure. The
 * headings and buttons below are therefore built EMPTY, and each function that
 * changes what a group holds takes the repaint as a callback instead of doing
 * it, so a caller cannot move a row without also asking the one writer to
 * decide what that means.
 *
 * These are plain functions over their arguments rather than a factory closed
 * over the page's state, deliberately. A factory would have to be constructed
 * before `applyFilter` and then be read BY `applyFilter`, so the seam the
 * single-writer rule lives on would gain a mutable slot pointing back at it.
 */

import { el, nextId } from '../../ui/dom';
import { button } from '../dom';
import { enableAll } from '../model/browse';
import { commitOverrides, getState, reportFailure } from '../store';

export interface RowRef {
  /** The shortcut's identity in the override layer, so a bulk action can build
   *  the next `disabled` list without reading it back off the node. */
  id: string;
  matchKey: string;
  /** Every alias the shortcut answers to, lowercased: what the "omnibox only"
   *  badge is decided from, and the reason it can be decided again after a
   *  switch moves without re-reading the row's chips out of the DOM. */
  keys: string[];
  haystack: string;
  order: number;
  node: HTMLElement;
  /** The "omnibox only" badge. Always built, never destroyed: whether it shows
   *  depends on the live keyword set and on which group the row is in, both of
   *  which a click can change, so `applyFilter` writes it like it writes the
   *  counts. */
  marker: HTMLElement;
  /** Puts the row's own switch and dimming into a state the user did not click
   *  it into, for the bulk actions in the hidden group. */
  setOn: (on: boolean) => void;
  /** The section group this row belongs to whenever it is switched on. A
   *  switched-off row is drawn under "Hidden shortcuts" and still remembers
   *  this, because that is where switching it back on has to return it. */
  home: GroupRef;
  /** The group the row is drawn in right now: `home`, or the hidden group. */
  group: GroupRef;
}

export interface GroupRef {
  /** The section id, which is what the collapsed state is remembered under. */
  id: string;
  /** The heading's words, which a run of this section's switched-off rows
   *  repeats inside the hidden group. */
  label: string;
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
 * One section's worth of switched-off rows inside "Hidden shortcuts": a small
 * heading, and the one action that switches all of them back on.
 *
 * A run is a VISUAL grouping inside one collapsible group, not a group of its
 * own. It owns no fold, registers no id with `collapse()`, and its rows stay
 * filed under the hidden group so the counts keep coming from one list. The
 * heading is a flex item ordered into the run it names, which is why
 * `renderBrowse`'s single `position` counter also allocates a slot for it.
 */
export interface RunRef {
  /** The section this run's rows return to. It is a section id, but it is used
   *  only to tally rows by their home; nothing folds under it. */
  id: string;
  head: HTMLElement;
  action: HTMLButtonElement;
  home: GroupRef;
}

/**
 * A group heading, its disclosure and the host its rows live in. Sections and
 * "Hidden shortcuts" are built by the same function on purpose: Collapse all,
 * Expand all and the fold-locked-while-filtering rule are written once, and
 * the hidden group cannot drift into being a special case of them.
 *
 * `onToggle` is handed the group's id and does the rest. The click records an
 * intent here and nothing more, because whether the fold is even writable
 * depends on the live filter, which is the caller's question.
 */
export function makeGroup(
  id: string,
  title: string,
  onToggle: (id: string) => void,
  note?: string,
  extra?: HTMLElement,
): GroupRef {
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
  // Outside the rows host, so both are still readable with the group folded,
  // which is how the hidden group starts. The whole-group action is the one
  // control on this page that is worth reaching without unfolding first: a
  // user who declined two packs wants them back, not a list of them.
  if (note) children.push(el('p', { class: 'group-note', text: note }));
  if (extra) children.push(extra);
  children.push(rows);
  const group = el('section', { class: 'group', children });

  toggle.addEventListener('click', () => onToggle(id));

  return { id, label: title, node: group, toggle, rowsHost: rows, count: countNode, rows: [] };
}

/**
 * The heading one section's switched-off rows sit under inside the hidden
 * group, and the action that switches all of them back on.
 *
 * It goes into the hidden group's rows host as a flex item ordered just above
 * the run it names, rather than into a container of its own, so a row that
 * moves in later needs no new parent: `place` appends it wherever, and its
 * `order` drops it back under this heading. That also keeps every row in the
 * group in ONE list, which is what lets `applyFilter` stay the only counter.
 */
export function makeRun(
  hiddenGroup: GroupRef,
  home: GroupRef,
  order: number,
  onAction: () => void,
): RunRef {
  // Wordless for the same reason the counts are: `applyFilter` decides what
  // this says, from what the run holds at the time.
  const action = button('', onAction, 'btn btn-sm btn-ghost');
  const head = el('div', {
    class: 'run-head',
    children: [el('span', { class: 'run-title', text: home.label }), action],
  });
  head.style.order = String(order);
  hiddenGroup.rowsHost.append(head);
  return { id: home.id, head, action, home };
}

/** The switched-off rows of one section: the hidden group holds rows from
 *  every section in one list, and a run's action is about its own. */
export function rowsOf(hiddenGroup: GroupRef, home: GroupRef): RowRef[] {
  return hiddenGroup.rows.filter((row) => row.home === home);
}

/**
 * Switches a whole run, or the whole group, back on.
 *
 * ONE write. The next `disabled` list is built in full and committed once,
 * because calling the per-row switch in a loop would be a burst of saves, one
 * `onStateChanged` each, which is the pattern `syncRules` serialization
 * exists to survive (AGENTS.md invariant 15).
 *
 * Nothing here waits for storage, the same way and for the same reason the
 * single switch does not: a list that only moved once storage answered would
 * read as a control that did not take. `focus` goes to `landing` because
 * the button that ran this is hidden the moment its run empties, and removing
 * the focused element drops a keyboard user at the top of the document.
 *
 * `onChanged` is `applyFilter`: this moves rows and writes their switches, and
 * then asks the one writer what the page now says.
 */
export function turnOn(
  rows: RowRef[],
  landing: HTMLElement,
  removed: WeakSet<HTMLElement>,
  onChanged: () => void,
): void {
  const live = rows.filter((row) => !removed.has(row.node));
  if (live.length === 0) return;
  const next = enableAll(
    getState().overrides.disabled,
    live.map((row) => row.id),
  );
  // The write is issued first and nothing waits for it: `commitOverrides`
  // applies the new state before its first `await`, so the rows below still
  // move in the same tick as the click, and `applyFilter` gets to read a
  // command list these shortcuts are already in when it decides which
  // keywords the address bar answers to.
  void commitOverrides({ ...getState().overrides, disabled: next }).catch(reportFailure);
  for (const row of live) {
    row.setOn(true);
    move(row, row.home);
  }
  onChanged();
  landing.focus();
}

/** Files a row under a group: the row's node, the group's list and the row's
 *  idea of where it is, written in one place so they cannot disagree. */
export function place(ref: RowRef, to: GroupRef): void {
  ref.group = to;
  to.rows.push(ref);
  to.rowsHost.append(ref.node);
}

/**
 * Files a row under another group, and ANSWERS with the element that has to
 * be focused again once `applyFilter` has decided what is on screen. It does
 * not focus it itself.
 *
 * `append` on a node that is already in the document is a removal and an
 * insertion, and removing the focused element sends focus to the body. A
 * keyboard user who pressed Space on the switch would lose their place. But
 * refocusing here would not put it back: at this point the destination still
 * has whatever visibility the PREVIOUS `applyFilter` left it with, and two
 * ordinary cases have it inside a `display: none` subtree, where `focus()` is
 * a silent no-op that leaves focus on `<body>`. The hidden group is folded by
 * default, so switching any row off hits it, and a group holding nothing is
 * hidden outright. So the caller focuses, after `applyFilter`.
 */
export function move(ref: RowRef, to: GroupRef): HTMLElement | null {
  if (ref.group === to) return null;
  const focused = ref.node.contains(document.activeElement) ? document.activeElement : null;
  ref.group.rows = ref.group.rows.filter((row) => row !== ref);
  place(ref, to);
  return focused instanceof HTMLElement ? focused : null;
}
