/**
 * One row of the browse list: the keyword chips, what the shortcut is, where it
 * goes, and the three controls every row offers.
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
 *
 * It closes over nothing in `renderBrowse`, writes no count and never touches
 * `row.hidden`, which is what lets a reader check that `applyFilter` in
 * `views/browse.ts` is the only writer of those without reading a row builder
 * first. The one `hidden` written
 * below is the badge's starting value, at construction, before the row is in a
 * group at all; every write after that is `applyFilter`'s. What this file DOES
 * own is the two writes a click makes to the row's own dimming and checkbox,
 * and both are handed back to the caller as `setOn` so a bulk action can make
 * them too.
 */

import { destinationOf } from '../../lib/commands';
import { shortcutId } from '../../lib/overrides';
import { stripScheme } from '../../lib/text';
import type { Overrides, ShortcutEdit } from '../../lib/types';
import { el } from '../../ui/dom';
import { confirmButton, iconButton, switchControl } from '../dom';
import { exampleOf } from '../model/browse';
import type { Entry } from '../model/browse';
import { go } from '../router';
import { commitOverrides, getState, reportFailure } from '../store';

/** The one sentence a meta shortcut's Delete button adds: `bl`, `add` and `set`
 *  are deletable like everything else, and deleting one is worth a word because
 *  it reads as though it takes the options page with it. It does not, and this
 *  says so without promising the keyword itself comes back. */
const META_DELETE_TITLE = 'The toolbar popup still opens this page without this keyword.';

/** The row's node, the badge `applyFilter` writes, and the one way its on-off
 *  state is written from outside a click on its own switch: a bulk action in
 *  the hidden group. */
export interface RowNode {
  node: HTMLElement;
  marker: HTMLElement;
  setOn: (on: boolean) => void;
}

export function renderRow(
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
  body.append(el('div', { class: 'row-url', text: stripScheme(destination), title: destination }));
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
        ? // `edits[id]` is deliberately KEPT. There is no per-shortcut restore:
          // the ways back are Reset to defaults, Start over, and importing a
          // file that predates the delete with Replace everything, and all
          // three have to return the shortcut the user had rather than the one
          // the registry ships.
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
