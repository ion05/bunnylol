/**
 * The "Shortcuts" route: the filterable, grouped list of every shortcut there
 * is, shipped or user-created.
 *
 * A switched-off shortcut is NOT drawn in its section. It is drawn last on the
 * page, under one folded "Hidden shortcuts" heading, so a user who declined
 * three packs on the welcome picker sees a shorter page rather than a page of
 * dead rows. The section groups and their counts are therefore about live
 * shortcuts only, and the switch moves a row between the two places.
 *
 * The route is three files, split along one line: `applyFilter` below is the
 * ONLY writer of `row.hidden`, `rowsHost.hidden`, every count on the page and
 * the "omnibox only" badge. `browse-row.ts` builds a row and `browse-groups.ts`
 * builds and refiles the groups, and neither of them writes any of those. So
 * the rule can be checked by reading one function here and grepping two short
 * modules, rather than by holding one 380-line closure in mind. Everything left
 * in `renderBrowse` is either panel assembly or something `applyFilter` reads.
 */

import { BUILTIN_COMMANDS } from '../../lib/commands';
import { firstKey } from '../../lib/overrides';
import { activeKeywords, suggest } from '../../lib/resolve';
import type { Command } from '../../lib/types';
import { el } from '../../ui/dom';
import { button } from '../dom';
import {
  browseEntries,
  browseGroups,
  countLabel,
  haystackOf,
  hiddenActions,
  HIDDEN_GROUP_ID,
} from '../model/browse';
import type { CollapseState } from '../model/collapse';
import { createCollapseState, groupExpanded, safeLocalStorage } from '../model/collapse';
import { go } from '../router';
import { getCommands, getFilter, getState, setFilter, takeNotice } from '../store';
import type { GroupRef, RowRef, RunRef } from './browse-groups';
import { makeGroup, makeRun, move, place, rowsOf, turnOn } from './browse-groups';
import { renderRow } from './browse-row';

/** The group every switched-off shortcut is drawn under, last on the page. */
const HIDDEN_TITLE = 'Hidden shortcuts';

/** One sentence, under the heading rather than inside the fold, because the
 *  group is folded by default and the question it answers is asked by the
 *  heading being there at all. */
const HIDDEN_NOTE =
  'Shortcuts you switched off, plus the shipped packs you did not turn on: switch one back on to put it in its section.';

/** Why a heading refuses to fold while the filter is live. */
const FOLD_LOCKED_TITLE = 'Clear the filter to fold groups';

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
    () => turnOn(hiddenGroup.rows.slice(), filter, removed, applyFilter),
    'btn btn-sm btn-ghost',
  );
  const groupActions = el('div', { class: 'group-actions', children: [enableEverything] });

  // Built on every render, whether or not anything is switched off, and hidden
  // by `applyFilter` when it holds no rows: exactly what already happens to a
  // section whose rows the filter took away. Building it on demand instead
  // would put a second decider of whether a group is on screen inside the
  // switch handler, next to the one that is supposed to be the only one.
  const hiddenGroup = makeGroup(
    HIDDEN_GROUP_ID,
    HIDDEN_TITLE,
    toggleFold,
    HIDDEN_NOTE,
    groupActions,
  );
  const anyHidden = entries.some((entry) => entry.disabled);

  // One counter across every section rather than an index per group, because a
  // row's `order` also has to sort it inside the hidden group, where rows from
  // several sections meet. Counting through the sections in order keeps them
  // together there, and gives each run's heading the slot just above its rows.
  let position = 0;
  for (const section of browseGroups(entries, getState().overrides.sections)) {
    const home = makeGroup(section.id, section.label, toggleFold);
    runRefs.push(
      makeRun(hiddenGroup, home, position++, () =>
        turnOn(rowsOf(hiddenGroup, home), home.toggle, removed, applyFilter),
      ),
    );
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
   * What a click on a group heading does. It records the intent and nothing
   * else; `applyFilter` is the only writer of what is on screen.
   *
   * Inert while a query is live, because `applyFilter` force-expands every
   * group then: the fold would be recorded and nothing on screen would move, so
   * the click would read as a control that did not take.
   */
  function toggleFold(id: string): void {
    if (filtering()) return;
    collapse().set(id, !collapse().isCollapsed(id));
    applyFilter();
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

  filter.addEventListener('input', applyFilter);
  applyFilter();

  nodes.push(panel);
  return nodes;
}
