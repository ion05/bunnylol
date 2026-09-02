/**
 * The `#welcome` route: the first-run pack picker.
 *
 * It asks exactly one question — which packs of shipped shortcuts do you want —
 * and answers it with exactly one write. The ticks live in a `Set` local to
 * this render and touch storage only when Continue is pressed, so a user who
 * closes the tab half-way through keeps whatever the install already wrote
 * (`lib/install.ts` writes the starter pick before the rules are ever built).
 *
 * The pick is authoritative, not additive: Continue re-enables every shipped
 * shortcut in a pack it picks, including ones switched off by hand. The page
 * says so in as many words, because the Settings card that links here promises
 * it does.
 */

import { BUILTIN_COMMANDS } from '../../lib/commands';
import { categoryPicks } from '../../lib/onboarding';
import type { PickRow } from '../../lib/onboarding';
import { FORCE_SEARCH_PREFIXES } from '../../lib/types';
import { el, nextId } from '../../ui/dom';
import { button } from '../dom';
import { closingLine, initialPicks, pickToState } from '../model/welcome';
import { go } from '../router';
import { applyState, commitState, getState, reportFailure } from '../store';

export function renderWelcome(): Node[] {
  const overrides = getState().overrides;
  const rows = categoryPicks(BUILTIN_COMMANDS);
  const picked = initialPicks(overrides);

  const error = el('p', { class: 'msg msg-error', attrs: { role: 'alert' } });
  error.hidden = true;

  const starters = rows.filter((row) => !row.optional);
  const optional = rows.filter((row) => row.optional);

  const nodes: Node[] = [
    el('h1', { text: 'Welcome to BunnyLol' }),
    el('p', {
      text:
        'Type a keyword in the address bar and BunnyLol takes you straight there.' +
        ' Turn on the packs you want. None of it is final — every shortcut can be' +
        ' renamed, moved, switched off or deleted afterwards, and you can come back' +
        ' to this screen from Settings.',
    }),
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
      el('p', {
        class: 'faint',
        text: 'School-specific shortcuts. Leave these off unless you go there.',
      }),
      el('div', {
        class: 'picks',
        // Named by the heading above it, or the second grid is an unlabelled
        // group of checkboxes that reads exactly like the first one.
        attrs: { role: 'group', 'aria-labelledby': head.id },
        children: optional.map((row) => pickCard(row, picked)),
      }),
    );
  }

  nodes.push(escapeNote());

  nodes.push(
    el('p', {
      text:
        'Continue turns on every shipped shortcut in the packs you tick — including' +
        ' any you had switched off by hand — and turns off the ones in the packs you' +
        ' leave unticked. Shortcuts you made yourself are never touched.',
    }),
  );

  const skip = button('Skip', () => go('#help'), 'btn btn-ghost');
  // Both buttons are captured by the handler so it can lock them for the one
  // write; the closure only runs on a click, long after both are bound.
  const proceed = button(
    'Continue',
    () => void save(picked, proceed, skip, error),
    'btn btn-primary',
  );

  nodes.push(
    el('div', { class: 'form-actions', children: [proceed, skip] }),
    error,
    el('p', { class: 'faint', text: closingLine(overrides) }),
  );

  return [el('section', { class: 'welcome', children: nodes })];
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
 * The escape hatch, stated on the one screen everybody sees. The first word of
 * a query is always a command when it matches one, which is only liveable
 * because of this — so the characters are read off `FORCE_SEARCH_PREFIXES`
 * rather than typed out here, and the sentence cannot drift from the parser.
 */
function escapeNote(): HTMLElement {
  const prefixes = FORCE_SEARCH_PREFIXES;
  const parts: (Node | string)[] = [
    'The first word you type is a shortcut whenever it matches one — ',
    el('code', { text: 'gh facebook/react' }),
    ' opens the repository rather than searching for it. Put ',
  ];
  prefixes.forEach((prefix, index) => {
    if (index > 0) parts.push(index === prefixes.length - 1 ? ' or ' : ', ');
    parts.push(el('code', { text: prefix }));
  });
  parts.push(
    ' in front to search for the words instead: ',
    el('code', { text: `${prefixes[0]}gh cheat sheet` }),
    ' searches for “gh cheat sheet”.',
  );
  return el('div', { class: 'escape', children: parts });
}

/**
 * The one write. `commitState` applies it optimistically and persists both
 * halves of the state in a single `chrome.storage.local.set`, which is what
 * keeps the install from producing the burst of saves that `syncRules`'
 * serialization exists to survive.
 */
async function save(
  picked: Set<string>,
  proceed: HTMLButtonElement,
  skip: HTMLButtonElement,
  error: HTMLElement,
): Promise<void> {
  proceed.disabled = true;
  skip.disabled = true;
  error.hidden = true;

  const before = getState();
  try {
    await commitState(pickToState(picked, before));
  } catch (err) {
    // `commitState` applies the pick optimistically, so a rejected write would
    // otherwise leave the page — and every view rendered after it — showing a
    // pick that is not in storage.
    applyState(before);
    reportFailure(err);
    error.textContent = 'Could not save your pick — try Continue again.';
    error.hidden = false;
    proceed.disabled = false;
    skip.disabled = false;
    return;
  }

  go('#help');
}
