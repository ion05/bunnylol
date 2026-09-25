/**
 * The "Suggested shortcuts" card at the top of the Shortcuts route: sites the
 * user keeps going back to, each one click from a prefilled New shortcut form.
 *
 * It sits outside the rows and groups and writes nothing `applyFilter` owns.
 * Hiding it while a query is live is `applyFilter`'s call, on the host this
 * returns; this file never writes `hidden`. With nothing to offer it leaves the
 * host empty and `.suggest:empty` takes it off the page.
 *
 * A suggestion's name comes off a page title in the user's history, which is
 * untrusted text, so it reaches the DOM only through `el` (invariant 11).
 */

import { hasHistoryAccess, loadSuggestions, requestHistoryAccess } from '../../lib/history';
import { prefillFor } from '../../lib/suggest';
import type { Suggestion } from '../../lib/suggest';
import { prettyUrl } from '../../lib/text';
import { el } from '../../ui/dom';
import { button, iconButton, panelCard } from '../dom';
import { go } from '../router';
import { commitSettings, getCommands, getState, reportFailure } from '../store';

const TITLE = 'Suggested shortcuts';
const OFFER =
  'Suggest shortcuts for sites you visit often. BunnyLol reads your browsing history on this device only; nothing leaves your browser.';

/** Returned empty and filled once the history has been read, which is async. */
export function renderSuggestions(): HTMLElement {
  const host = el('div', { class: 'suggest' });
  void fill(host, false);
  return host;
}

async function fill(host: HTMLElement, refocus: boolean): Promise<void> {
  const granted = await hasHistoryAccess();
  const found = granted ? await loadSuggestions(getCommands(), getState().settings) : [];
  // The page may have re-rendered while the history was being read, and taken
  // this host with it.
  if (!host.isConnected) return;
  host.textContent = '';

  if (!granted) {
    const card = panelCard(TITLE, OFFER);
    card.body.append(
      el('div', {
        class: 'btn-row',
        children: [
          // The request runs straight from the click: Chrome refuses one that
          // is not a direct response to a user gesture.
          button(
            'Suggest shortcuts',
            () =>
              void requestHistoryAccess().then((ok) => {
                if (ok) void fill(host, true);
              }),
            'btn btn-sm',
          ),
        ],
      }),
    );
    host.append(card.section);
    return;
  }
  if (found.length === 0) return;

  const card = panelCard(TITLE, 'Sites you keep going back to that no shortcut reaches yet.');
  card.body.append(
    el('div', { class: 'rows', children: found.map((s) => suggestionRow(s, host)) }),
  );
  host.append(card.section);
  // The button just pressed went out with the old card, which drops focus on
  // `<body>`; the first control of the new one is the nearest thing to it.
  if (refocus) host.querySelector('button')?.focus();
}

function suggestionRow(s: Suggestion, host: HTMLElement): HTMLElement {
  return el('div', {
    class: 'row',
    children: [
      el('div', { class: 'row-keys', children: [el('code', { class: 'chip', text: s.alias })] }),
      el('div', {
        class: 'row-body',
        children: [
          el('div', { class: 'row-name', text: s.name }),
          el('div', { class: 'row-url', text: prettyUrl(s.url), title: s.url }),
        ],
      }),
      el('div', {
        class: 'row-actions',
        children: [
          button(
            'Add',
            () => go(`#new?prefill=${encodeURIComponent(prefillFor(s))}`),
            'btn btn-sm',
          ),
          iconButton(`Dismiss ${s.name}`, 'close', () => {
            const settings = getState().settings;
            void commitSettings({
              ...settings,
              dismissedSuggestions: [...settings.dismissedSuggestions, s.host],
            }).catch(reportFailure);
            // Our own write comes back as an echo, and an echo does not
            // re-render, so the card refills itself. `commitSettings` applies
            // the dismissal before it awaits, so the reload already skips it.
            void fill(host, true);
          }),
        ],
      }),
    ],
  });
}
