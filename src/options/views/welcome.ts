/**
 * The `#welcome` route. Placeholder for the first-run category picker
 * (PR 9 fills this in) — routed now so `router.ts`'s `RouteName` union can
 * carry `'welcome'` without a dangling case in `renderView`.
 */

import { el } from '../../ui/dom';

export function renderWelcome(): Node[] {
  return [
    el('section', {
      class: 'panel',
      children: [
        el('div', {
          class: 'panel-body',
          children: [
            el('h2', { text: 'Welcome' }),
            el('p', { text: 'Coming soon.' }),
            el('a', { text: 'Go to your shortcuts', attrs: { href: '#help' } }),
          ],
        }),
      ],
    }),
  ];
}
