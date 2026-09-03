/**
 * The `#welcome` route: the first-run pack picker.
 *
 * It asks exactly one question, which packs of shipped shortcuts do you want,
 * and answers it with exactly one write. The ticks live in a `Set` local to
 * this render and touch storage only when Continue is pressed, so a user who
 * closes the tab half-way through keeps whatever the install already wrote
 * (`lib/install.ts` writes the starter pick before the rules are ever built).
 *
 * The cards, the ticks and the write are `views/packs.ts`, shared with the
 * `#packs` screen a returning user reaches from Settings. What is only here is
 * the first-run framing: the introduction to a product the user has never seen,
 * the escape-hatch explainer, and Skip.
 */

import { FORCE_SEARCH_PREFIXES } from '../../lib/types';
import { el } from '../../ui/dom';
import { button } from '../dom';
import { go } from '../router';
import { getState } from '../store';
import { packChoice, pickError, savePick } from './packs';

export function renderWelcome(): Node[] {
  const choice = packChoice(getState().overrides);
  const error = pickError();

  const nodes: Node[] = [
    el('h1', { text: 'Welcome to BunnyLol' }),
    el('p', {
      text:
        'An independent rebuild of the bunnylol command bar used inside Meta, which lets' +
        ' you set custom keywords and search functions for your browser. Default packs' +
        ' cover a lot of developer tools, AI tools, and general Google and Microsoft' +
        ' suite tools, but feel free to add your own or edit/remove any of the default' +
        ' ones.',
    }),
    // The disclaimer belongs on this screen, not only in the README and the
    // store listing. This paragraph is the strongest claim the project makes
    // about Meta and the only one a user or a store reviewer actually meets at
    // runtime, so the sentence that disclaims it has to be next to it.
    el('p', {
      class: 'faint',
      text:
        'Not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc.' +
        ' BunnyLol is an independent open-source project.',
    }),
    ...choice.nodes,
    escapeNote(),
  ];

  const skip = button('Skip', () => go('#help'), 'btn btn-ghost');
  // Both buttons are captured by the handler so it can lock them for the one
  // write; the closure only runs on a click, long after both are bound.
  const proceed = button(
    'Continue',
    () => void savePick(choice.picked, [proceed, skip], error, 'Continue'),
    'btn btn-primary',
  );

  nodes.push(el('div', { class: 'form-actions', children: [proceed, skip] }), error);

  return [el('section', { class: 'welcome', children: nodes })];
}

/**
 * The escape hatch, stated on the one screen everybody sees. The first word of
 * a query is always a command when it matches one, which is only liveable
 * because of this, so the characters are read off `FORCE_SEARCH_PREFIXES`
 * rather than typed out here, and the sentence cannot drift from the parser.
 */
function escapeNote(): HTMLElement {
  const prefixes = FORCE_SEARCH_PREFIXES;
  const parts: (Node | string)[] = [
    'The first word you type is a shortcut whenever it matches one: ',
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
