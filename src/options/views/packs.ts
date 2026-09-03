/**
 * The `#packs` route: the pack picker for somebody who already uses the
 * extension, plus the pack-card rendering the first-run `#welcome` screen
 * shares with it.
 *
 * The two screens ask the same question and write the same answer, so the
 * cards, the ticks and the write live here once and each screen supplies only
 * its own words and buttons. They are not the same screen: `#welcome` is the
 * tab the install opens, so it introduces the product and offers Skip, while
 * this one is reached on purpose from Settings by a user changing their mind,
 * so it says what a pack does and offers Save and Cancel.
 *
 * The cards are here rather than in `options/dom.ts` because they are not a
 * stateless widget: every checkbox writes into the `Set` its screen will hand
 * to `commitState`, so a card only means anything next to that Set.
 *
 * The pick is authoritative, not additive: saving re-enables every shipped
 * shortcut in a pack it picks, including ones switched off by hand, and
 * switches off every shortcut in a pack it does not.
 */

import { BUILTIN_COMMANDS } from '../../lib/commands';
import { categoryPicks } from '../../lib/onboarding';
import type { PickRow } from '../../lib/onboarding';
import type { Overrides } from '../../lib/types';
import { el, nextId } from '../../ui/dom';
import { button } from '../dom';
import { initialPicks, pickToState } from '../model/welcome';
import { go } from '../router';
import { applyState, commitState, getState, reportFailure } from '../store';

export interface PackChoice {
  /** The ticks. The checkboxes mutate this in place, and it is what the one
   *  write is built from, so it belongs to the render that made the cards. */
  picked: Set<string>;
  /** The grids, in the order both screens show them. */
  nodes: Node[];
}

/**
 * Every pack card, ticked from the pick already on record. Shared verbatim by
 * both screens so a pack added to the registry cannot appear on one of them
 * and not the other.
 */
export function packChoice(overrides: Overrides): PackChoice {
  const rows = categoryPicks(BUILTIN_COMMANDS);
  const picked = initialPicks(overrides);

  const starters = rows.filter((row) => !row.optional);
  const optional = rows.filter((row) => row.optional);

  const nodes: Node[] = [
    el('div', {
      class: 'picks',
      attrs: { role: 'group', 'aria-label': 'Shortcut packs' },
      children: starters.map((row) => pickCard(row, picked)),
    }),
  ];

  if (optional.length > 0) {
    const head = el('div', {
      class: 'optional-head',
      id: nextId('optional'),
      text: 'Optional packs',
    });
    nodes.push(
      head,
      el('p', { class: 'faint', text: 'School Specific Packs' }),
      el('div', {
        class: 'picks',
        // Named by the heading above it, or the second grid is an unlabelled
        // group of checkboxes that reads exactly like the first one.
        attrs: { role: 'group', 'aria-labelledby': head.id },
        children: optional.map((row) => pickCard(row, picked)),
      }),
    );
  }

  return { picked, nodes };
}

/** One pack: a checkbox, its name, how many shortcuts it holds and the first
 *  three keywords in it, plus a chevron that unfolds the full list so a tick is
 *  never a guess. Everything but the checkbox comes off the registry, so the
 *  card cannot go stale when a command is added. */
function pickCard(row: PickRow, picked: Set<string>): HTMLElement {
  const input = el('input', { attrs: { type: 'checkbox' } });
  input.checked = picked.has(row.id);
  input.addEventListener('change', () => {
    if (input.checked) picked.add(row.id);
    else picked.delete(row.id);
  });

  const text = el('span', {
    children: [
      el('span', { class: 'pick-name', text: row.label }),
      el('span', {
        class: 'pick-count',
        text: ` · ${row.count} ${row.count === 1 ? 'shortcut' : 'shortcuts'}`,
      }),
      el('span', { class: 'pick-keys', text: row.sample.join(' · ') }),
    ],
  });

  const list = el('ul', {
    class: 'pick-list',
    id: nextId('pick-list'),
    children: row.members.map((member) =>
      el('li', {
        class: 'pick-item',
        children: [
          el('span', {
            class: 'pick-item-keys',
            children: member.keys.map((key) => el('code', { class: 'chip', text: key })),
          }),
          el('span', { class: 'pick-item-name', text: member.name }),
          el('span', { class: 'pick-item-desc', text: member.description }),
        ],
      }),
    ),
  });
  list.hidden = true;

  // Outside the label on purpose: a button inside it would be a second
  // activation target for the checkbox, and unfolding the list must not tick
  // or untick the pack.
  const toggle = el('button', {
    class: 'pick-toggle',
    title: `Show the shortcuts in ${row.label}`,
    attrs: {
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': list.id,
      'aria-label': `Show the shortcuts in ${row.label}`,
    },
    children: [el('span', { class: 'group-chevron', attrs: { 'aria-hidden': 'true' } })],
  });
  toggle.addEventListener('click', () => {
    const open = list.hidden;
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    const label = `${open ? 'Hide' : 'Show'} the shortcuts in ${row.label}`;
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  });

  return el('div', {
    class: 'pick',
    children: [
      el('div', {
        class: 'pick-head',
        children: [el('label', { class: 'pick-main', children: [input, text] }), toggle],
      }),
      list,
    ],
  });
}

/**
 * The one write, shared by both screens. `commitState` applies it
 * optimistically and persists both halves of the state in a single
 * `chrome.storage.local.set`, which is what keeps a pick from producing the
 * burst of saves that `syncRules`' serialization exists to survive.
 *
 * `actions` is every button on the screen, locked for the duration so a second
 * click cannot open a second write, and `confirmLabel` names the button the
 * user pressed so the failure line points at the thing in front of them.
 */
export async function savePick(
  picked: Set<string>,
  actions: HTMLButtonElement[],
  error: HTMLElement,
  confirmLabel: string,
): Promise<void> {
  for (const action of actions) action.disabled = true;
  error.hidden = true;

  const before = getState();
  try {
    await commitState(pickToState(picked, before));
  } catch (err) {
    // `commitState` applies the pick optimistically, so a rejected write would
    // otherwise leave the page, and every view rendered after it, showing a
    // pick that is not in storage.
    applyState(before);
    reportFailure(err);
    error.textContent = `Could not save your pick. Try ${confirmLabel} again.`;
    error.hidden = false;
    for (const action of actions) action.disabled = false;
    return;
  }

  go('#help');
}

/** The error line both screens keep hidden until a write actually fails. */
export function pickError(): HTMLElement {
  const error = el('p', { class: 'msg msg-error', attrs: { role: 'alert' } });
  error.hidden = true;
  return error;
}

export function renderPacks(): Node[] {
  const choice = packChoice(getState().overrides);
  const error = pickError();

  // Cancel leaves without writing, so the pick on record is whatever it was
  // when the screen opened: the ticks live only in `choice.picked`.
  const cancel = button('Cancel', () => go('#help'), 'btn btn-ghost');
  const save = button(
    'Save',
    () => void savePick(choice.picked, [save, cancel], error, 'Save'),
    'btn btn-primary',
  );

  return [
    // `.welcome` is the centred prose-plus-grid column, not a first-run marker:
    // both pack screens are one narrow column of text above a grid of cards.
    el('section', {
      class: 'welcome',
      children: [
        el('h1', { text: 'Shortcut packs' }),
        el('p', {
          text:
            'Turning a pack on enables every shipped shortcut in it, including ones you' +
            ' switched off by hand. Turning a pack off switches all of them off. Your own' +
            ' shortcuts and your edits are left alone.',
        }),
        ...choice.nodes,
        el('div', { class: 'form-actions', children: [save, cancel] }),
        error,
      ],
    }),
  ];
}
