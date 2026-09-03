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
import type { Command, Overrides, ShortcutEdit } from '../../lib/types';
import { el, nextId } from '../../ui/dom';
import { button, confirmButton, iconButton, switchControl } from '../dom';
import {
  browseEntries,
  browseGroups,
  countLabel,
  enableAll,
  exampleOf,
  haystackOf,
  hiddenActions,
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

interface GroupRef {
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
 * filed under `hiddenGroup` so the counts keep coming from one list. The
 * heading is a flex item ordered into the run it names, which is why
 * `renderBrowse`'s single `position` counter also allocates a slot for it.
 */
interface RunRef {
  /** The section this run's rows return to. It is a section id, but it is used
   *  only to tally rows by their home; nothing folds under it. */
  id: string;
  head: HTMLElement;
  action: HTMLButtonElement;
  home: GroupRef;
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
 *
 * `reset`, NOT `expandAll`. The stored set holds the ids whose fold differs
 * from the default, so `expandAll` has to ADD "Hidden shortcuts" to it to open
 * that group, which is right for a button the user pressed and wrong here:
 * Start over would land the profile on a browse page with the hidden group
 * already unfolded, which is the state the folded default exists to prevent.
 */
export function forgetCollapsed(): void {
  collapse().reset();
}

export function renderBrowse(): Node[] {
  const entries = browseEntries(BUILTIN_COMMANDS, getState().overrides);
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
  const runRefs: RunRef[] = [];
  /** Rows whose shortcut was deleted; their nodes are gone from the DOM but
   *  they are still listed in `groupRefs`, and the counts must skip them. */
  const removed = new WeakSet<HTMLElement>();

  // Left wordless, like the counts: `applyFilter` writes what every control in
  // the hidden group says, so no label on the page has skipped the one function
  // that runs after every change.
  const enableEverything = button(
    '',
    // A copy, so what this acts on is the set that was in the group when it was
    // clicked. (`turnOn` does not mutate the list it walks: `move` REASSIGNS
    // `group.rows` with a `filter()`, so the array handed over here is never
    // touched.) The filter box is where focus lands: this action makes the
    // whole group disappear, and the button running it goes with it.
    () => turnOn(hiddenGroup.rows.slice(), filter),
    'btn btn-sm btn-ghost',
  );
  const groupActions = el('div', { class: 'group-actions', children: [enableEverything] });

  // Built on every render, whether or not anything is switched off, and hidden
  // by `applyFilter` when it holds no rows: exactly what already happens to a
  // section whose rows the filter took away. Building it on demand instead
  // would put a second decider of whether a group is on screen inside the
  // switch handler, next to the one that is supposed to be the only one.
  const hiddenGroup = makeGroup(HIDDEN_GROUP_ID, HIDDEN_TITLE, HIDDEN_NOTE, groupActions);
  const anyHidden = entries.some((entry) => entry.disabled);

  // One counter across every section rather than an index per group, because a
  // row's `order` also has to sort it inside the hidden group, where rows from
  // several sections meet. Counting through the sections in order keeps them
  // together there, and gives each run's heading the slot just above its rows.
  let position = 0;
  for (const section of browseGroups(entries, getState().overrides.sections)) {
    const home = makeGroup(section.id, section.label);
    makeRun(home, position++);
    for (const entry of section.entries) {
      // Declared before the row so the switch can close over it. The handler
      // only ever runs from a click, long after the assignment below.
      let ref: RowRef;
      const row = renderRow(
        entry,
        (deleted) => {
          removed.add(deleted);
          applyFilter();
          // The confirm button the user just pressed went out of the document
          // with the row, which drops focus on `<body>`. The filter box is
          // where it goes rather than a neighbouring row or this section's
          // heading: deleting the last row of a section hides the whole group,
          // and `focus()` inside a `display: none` subtree is a silent no-op.
          // The filter box is the one control on the route that is always
          // there, and it is where the next thing a user does starts.
          filter.focus();
        },
        // Moving the one node the switch is about, rather than re-rendering
        // the view. A re-render would be correct, `commitOverrides` applies the
        // new state before it awaits storage, but it would repaint ~170 rows
        // for a one-row change and throw away the control the user is still
        // touching. Moving parentage keeps `applyFilter` the only thing that
        // writes `row.hidden` and `rowsHost.hidden`: it runs straight after and
        // decides the counts, the two headings and what is on screen.
        (on) => {
          const refocus = move(ref, on ? ref.home : hiddenGroup);
          applyFilter();
          // AFTER `applyFilter`, because until it has run the destination still
          // has the visibility the last one left it: the hidden group is folded
          // by default and an empty group is hidden outright, and `focus()`
          // inside a `display: none` subtree silently drops focus on `<body>`.
          // `preventScroll`, because the row has just moved to the bottom of
          // the page and refocusing it would drag the page after it.
          refocus?.focus({ preventScroll: true });
        },
      );
      ref = {
        id: entry.id,
        matchKey: entry.matchKey,
        keys: entry.cmd.keys.map((key) => key.trim().toLowerCase()),
        haystack: haystackOf(entry.cmd),
        order: position++,
        node: row.node,
        marker: row.marker,
        setOn: row.setOn,
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

  /**
   * The aliases the address bar answers to right now, from the same list the
   * DNR rules are built from, so the "omnibox only" badge cannot drift from
   * what typing the keyword actually does.
   *
   * Memoized on the identity of the merged command list, which `applyState`
   * rebuilds on every commit and nothing else replaces. `applyFilter` also runs
   * on every keystroke in the filter box, and only a write can change this
   * answer.
   */
  let keywordSource: Command[] | null = null;
  let interceptedKeys = new Set<string>();
  function intercepted(): Set<string> {
    const commands = getCommands();
    if (commands !== keywordSource) {
      keywordSource = commands;
      interceptedKeys = new Set(activeKeywords(commands, getState().settings.interceptStopList));
    }
    return interceptedKeys;
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
    /** Rows in the hidden group, tallied by the section they return to, and
     *  rows filed in each group whether the filter matched them or not: what
     *  the runs' headings and actions are decided from below. */
    const inRun = new Map<string, number>();
    const filed = new Map<GroupRef, number>();
    const live = intercepted();
    for (const group of groupRefs) {
      let inGroup = 0;
      let held = 0;
      for (const row of group.rows) {
        if (removed.has(row.node)) continue;
        total += 1;
        held += 1;
        if (group === hiddenGroup) inRun.set(row.home.id, (inRun.get(row.home.id) ?? 0) + 1);
        // Which keywords the address bar claims changes as shortcuts are
        // switched on and off, so this is decided here with the counts rather
        // than once at render: a bulk switch-on would otherwise leave every row
        // it moved carrying a badge about a keyword that is now intercepted.
        // No badge under "Hidden shortcuts": a switched-off shortcut is not
        // intercepted anywhere, and saying so on every row in the group would
        // be repeating what the heading already says.
        row.marker.hidden = group === hiddenGroup || row.keys.some((key) => live.has(key));
        const rank = ranks.get(row.matchKey);
        const match = !query || rank !== undefined || row.haystack.includes(query);
        row.node.hidden = !match;
        // Reordering with `order` keeps the DOM untouched, so filtering ~170
        // rows costs a style recalc instead of a re-render.
        row.node.style.order = String(rank ?? (query ? 10000 + row.order : row.order));
        if (match) inGroup += 1;
      }
      filed.set(group, held);
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

    // The runs, from the same pass and by the same writer as the counts: a run
    // appears when its section has anything switched off, and its wording turns
    // on whether that section still has anything live, which the row switches
    // change several times a minute. Nothing here folds, so no run touches
    // `collapse()`.
    const painted = hiddenActions(
      runRefs.map((run) => ({
        label: run.home.label,
        hidden: inRun.get(run.id) ?? 0,
        live: filed.get(run.home) ?? 0,
      })),
    );
    runRefs.forEach((run, index) => {
      // Silent while a query is live: the filter's answer is one ranked list
      // across every section, so a heading claiming to name a run of the rows
      // under it would be naming a run the ranking has already broken up. The
      // whole-group action goes with them, for the reason `toolbarActions`
      // does: it would act on rows the query is not showing.
      run.head.hidden = query !== '' || !painted.runs[index].shown;
      const label = painted.runs[index].label;
      run.action.hidden = label === null;
      if (label !== null) run.action.textContent = label;
    });
    groupActions.hidden = query !== '' || painted.all === null;
    if (painted.all !== null) enableEverything.textContent = painted.all;

    count.textContent = countLabel({ on: visibleOn, shown: visible, total }, query !== '');

    empty.textContent = '';
    empty.hidden = visible > 0;
    if (visible === 0) {
      // Two different emptinesses. With a query up, the list has rows and none
      // of them matched, so the offer is to make the thing that was searched
      // for. With no query the list is genuinely empty, every shortcut having
      // been deleted, and the old copy asked "Nothing matches “”" and offered a
      // Create button prefilled with nothing.
      const typed = filter.value.trim();
      empty.append(
        el('p', {
          text: typed
            ? `Nothing matches “${typed}”.`
            : 'No shortcuts left. Reset to defaults in Settings brings the shipped ones back.',
        }),
        el('div', {
          class: 'btn-row',
          children: [
            button(
              typed ? 'Create a shortcut for it' : 'Create a shortcut',
              () => go(typed ? `#new?prefill=${encodeURIComponent(typed)}` : '#new'),
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
  function makeGroup(id: string, title: string, note?: string, extra?: HTMLElement): GroupRef {
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
  function makeRun(home: GroupRef, order: number): void {
    // Wordless for the same reason the counts are: `applyFilter` decides what
    // this says, from what the run holds at the time.
    const action = button('', () => turnOn(rowsOf(home), home.toggle), 'btn btn-sm btn-ghost');
    const head = el('div', {
      class: 'run-head',
      children: [el('span', { class: 'run-title', text: home.label }), action],
    });
    head.style.order = String(order);
    hiddenGroup.rowsHost.append(head);
    runRefs.push({ id: home.id, head, action, home });
  }

  /** The switched-off rows of one section: the hidden group holds rows from
   *  every section in one list, and a run's action is about its own. */
  function rowsOf(home: GroupRef): RowRef[] {
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
   */
  function turnOn(rows: RowRef[], landing: HTMLElement): void {
    const live = rows.filter((row) => !removed.has(row.node));
    if (live.length === 0) return;
    const next = enableAll(getState().overrides.disabled, live.map((row) => row.id));
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
    applyFilter();
    landing.focus();
  }

  /** Files a row under a group: the row's node, the group's list and the row's
   *  idea of where it is, written in one place so they cannot disagree. */
  function place(ref: RowRef, to: GroupRef): void {
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
  function move(ref: RowRef, to: GroupRef): HTMLElement | null {
    if (ref.group === to) return null;
    const focused = ref.node.contains(document.activeElement) ? document.activeElement : null;
    ref.group.rows = ref.group.rows.filter((row) => row !== ref);
    place(ref, to);
    return focused instanceof HTMLElement ? focused : null;
  }

  filter.addEventListener('input', applyFilter);
  applyFilter();

  nodes.push(panel);
  return nodes;
}

/** The row's node, the badge `applyFilter` writes, and the one way its on-off
 *  state is written from outside a click on its own switch: a bulk action in
 *  the hidden group. */
interface RowNode {
  node: HTMLElement;
  marker: HTMLElement;
  setOn: (on: boolean) => void;
}

function renderRow(
  entry: Entry,
  onRemoved: (row: HTMLElement) => void,
  onToggled: (on: boolean) => void,
): RowNode {
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
  //
  // The "omnibox only" badge is built for every row and starts hidden: whether
  // it applies depends on the live keyword set and on which group the row is
  // in, and both change without a re-render, so `applyFilter` decides it the
  // same way it decides the counts. Building it only for the rows that need one
  // meant a row switched on later could never get the badge and a row switched
  // off kept it.
  const marker = el('span', { class: 'badge badge-quiet', text: 'omnibox only' });
  marker.title =
    'Not intercepted in the address bar. Type bl, press Tab, then the keyword, or use the popup.';
  marker.hidden = true;
  name.append(marker);

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

  const toggle = switchControl(`Enable ${entry.cmd.name}`, !entry.disabled, (on) => {
    const next = getState().overrides.disabled.filter((id) => id !== entry.id);
    if (!on) next.push(entry.id);
    // Optimistic, and deliberately before the await: the switch has already
    // moved under the pointer, and a row that waits for storage to answer
    // reads as a control that did not take.
    row.classList.toggle('off', !on);
    // Issued before the move, and still without waiting for it:
    // `commitOverrides` applies the new state before its first `await`, so what
    // `onToggled` repaints is decided against a command list this shortcut has
    // already joined or left. That is what the "omnibox only" badge reads.
    void commitOverrides({ ...getState().overrides, disabled: next }).catch(reportFailure);
    // Moves the row between its section and "Hidden shortcuts", and repaints
    // the counts on both headings.
    onToggled(on);
  });

  // Edit, Delete, then the switch: the two actions that open or remove the row
  // sit together, and the state control stays at the edge where it is always
  // visible.
  actions.append(
    iconButton(`Edit ${entry.cmd.name}`, 'pencil', () => {
      go(`#edit?id=${encodeURIComponent(entry.id)}`);
    }),
    remove,
    toggle.node,
  );

  return {
    node: row,
    marker,
    // The dimming and the checkbox, and nothing else: the write, the move and
    // the counts belong to the bulk action calling this, which does all three
    // for a whole run at once. Setting `checked` fires no `change`, so this
    // cannot re-enter the handler above.
    setOn: (on) => {
      row.classList.toggle('off', !on);
      toggle.input.checked = on;
    },
  };
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
