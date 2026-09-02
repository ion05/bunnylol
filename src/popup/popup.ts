/**
 * The toolbar popup: a command bar over the same registry the address bar uses.
 *
 * This is the fallback surface — it works when interception does not (Dia's own
 * omnibox, Brave's shields), so it deliberately depends on nothing but storage,
 * the pure resolver and `chrome.tabs`.
 */

import { resolve, stripPassthrough, suggest } from '../lib/resolve';
import { loadResolveContext } from '../lib/storage';
import { toNavigableUrl } from '../lib/url';
import type { Command, Settings } from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';

/** More rows than fit; the list scrolls inside a fixed-height box. */
const SUGGESTION_LIMIT = 12;

let commands: Command[] = [];
let settings: Settings = DEFAULT_SETTINGS;
let matches: Command[] = [];
let rowNodes: HTMLLIElement[] = [];
/** -1 is the "no row selected" slot: Enter resolves exactly what was typed. */
let selected = -1;
/** Storage is async but the input is live immediately; do not render a wrong empty state. */
let ready = false;
/**
 * Arrow keys scroll the list under a stationary cursor, so Chrome re-fires
 * `mouseenter` on whatever row slid beneath the pointer. While this is set,
 * hover does not own the selection; a real pointer move clears it.
 */
let usingKeyboard = false;
/**
 * The last screen position a `mousemove` reported. Scrolling the list under a
 * stationary pointer makes Chrome emit a `mousemove` at the unchanged
 * coordinates, which would otherwise read as the user taking over.
 */
let lastX = -1;
let lastY = -1;
/** Enter can be pressed again while the first navigation waits on storage. */
let launching = false;

// ------------------------------------------------------------------ DOM ----

const root = document.getElementById('app') as HTMLDivElement;

const input = el('input', 'query');
input.type = 'text';
input.placeholder = 'gh facebook/react';
input.spellcheck = false;
input.autocomplete = 'off';
input.setAttribute('autocorrect', 'off');
input.setAttribute('autocapitalize', 'off');
input.setAttribute('aria-label', 'BunnyLol shortcut');
input.setAttribute('role', 'combobox');
input.setAttribute('aria-autocomplete', 'list');
input.setAttribute('aria-expanded', 'false');
input.setAttribute('aria-controls', 'results');

const destArrow = el('span', 'dest-arrow', '→');
const destUrl = el('span', 'dest-url');
const dest = el('div', 'dest');
dest.append(destArrow, destUrl);

const list = el('ul', 'results');
list.id = 'results';
list.setAttribute('role', 'listbox');
list.setAttribute('aria-label', 'Matching shortcuts');

const optionsButton = el('button', 'link', 'Manage shortcuts');
optionsButton.type = 'button';

const footer = el('footer', 'footer');
footer.append(optionsButton, el('span', 'hint', 'Tab completes · ⌘/Ctrl+Enter new tab'));

const bar = el('div', 'bar');
bar.append(input);
root.append(bar, dest, list, footer);

// ------------------------------------------------------------- rendering ---

/** Rebuilds the whole list. Any rebuild also drops the selection. */
function render(): void {
  if (!ready) return;
  matches = suggest(input.value, commands, SUGGESTION_LIMIT);
  selected = -1;
  input.removeAttribute('aria-activedescendant');

  const keyword = firstToken(input.value);
  rowNodes = matches.map((cmd, index) => buildRow(cmd, keyword, index));
  if (rowNodes.length > 0) {
    list.replaceChildren(...rowNodes);
  } else {
    list.replaceChildren(el('li', 'empty', 'No shortcut matches. Enter searches for it instead.'));
  }
  list.scrollTop = 0;
  input.setAttribute('aria-expanded', matches.length > 0 ? 'true' : 'false');
  renderDest();
}

function buildRow(cmd: Command, keyword: string, index: number): HTMLLIElement {
  const item = el('li', 'row');
  item.id = `row-${index}`;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', 'false');

  const key = el('span', 'row-key');
  key.append(...highlight(aliasFor(cmd, keyword), keyword));

  const text = el('span', 'row-text');
  text.append(el('span', 'row-name', cmd.name), el('span', 'row-desc', cmd.description));

  item.append(key, text);

  // The input must keep focus, so the row never becomes the click target's owner.
  item.addEventListener('mousedown', (event) => event.preventDefault());
  item.addEventListener('mouseenter', () => {
    if (!usingKeyboard) setSelected(index);
  });
  item.addEventListener('click', (event) => {
    launch(queryFor(index), event.metaKey || event.ctrlKey);
  });
  item.addEventListener('auxclick', (event) => {
    if (event.button === 1) launch(queryFor(index), true);
  });
  return item;
}

/** Where Enter goes right now — shown before it is pressed, truncated by CSS. */
function renderDest(): void {
  dest.classList.remove('is-error');
  destArrow.textContent = '→';
  destUrl.textContent = prettyUrl(resolve(queryFor(selected), commands, settings).url);
}

function setSelected(index: number, scroll = false): void {
  selected = index;
  rowNodes.forEach((node, i) => {
    const on = i === index;
    node.classList.toggle('is-selected', on);
    node.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on && scroll) node.scrollIntoView({ block: 'nearest' });
  });
  if (index >= 0) input.setAttribute('aria-activedescendant', rowNodes[index].id);
  else input.removeAttribute('aria-activedescendant');
  renderDest();
}

/** Cycles through the rows and back out to the raw text, the way the omnibox does. */
function move(delta: number): void {
  const span = matches.length + 1;
  if (span < 2) return;
  setSelected((((selected + 1 + delta) % span) + span) % span - 1, true);
}

// ------------------------------------------------------------ navigation ---

function launch(query: string, newTab: boolean): void {
  if (launching) return;
  launching = true;
  navigate(query, newTab).catch((err: unknown) => {
    launching = false;
    dest.classList.add('is-error');
    destArrow.textContent = '';
    destUrl.textContent = errorText(err);
  });
}

async function navigate(query: string, newTab: boolean): Promise<void> {
  // The input accepts Enter from the first frame, but `commands` and `settings`
  // arrive a tick later; resolving early turns every shortcut into a web search.
  await readyPromise;
  const url = toNavigableUrl(resolve(query, commands, settings).url);
  if (newTab) {
    await chrome.tabs.create({ url });
  } else {
    try {
      // No tabId: updates the active tab of the current window.
      await chrome.tabs.update({ url });
    } catch {
      // No active tab to reuse — a new tab beats dropping the navigation.
      await chrome.tabs.create({ url });
    }
  }
  window.close();
}

// --------------------------------------------------------------- queries ---

/** The query a row stands for: its alias, carrying whatever arguments were typed. */
function queryFor(index: number): string {
  const cmd = index >= 0 ? matches[index] : undefined;
  if (!cmd) return input.value;
  const key = aliasFor(cmd, firstToken(input.value));
  const args = restOfLine(input.value);
  return args ? `${key} ${args}` : key;
}

/**
 * The query Tab would complete to, or null when Tab has nothing to add and so
 * belongs to focus navigation instead.
 */
function completionFor(): string | null {
  // With an empty box the list is the catalogue, not a match on anything typed.
  if (!input.value.trim()) return null;
  const target = selected >= 0 ? matches[selected] : matches[0];
  if (!target) return null;
  const key = aliasFor(target, firstToken(input.value));
  if (!key) return null;
  const args = restOfLine(input.value);
  const completed = args ? `${key} ${args}` : `${key} `;
  return completed === input.value ? null : completed;
}

/** Prefers the alias the user is already typing, so the row does not read as a different command. */
function aliasFor(cmd: Command, keyword: string): string {
  const aliases = (cmd.keys ?? []).map((key) => key.trim()).filter((key) => key.length > 0);
  const typed = keyword.toLowerCase();
  const matched = typed ? aliases.find((key) => key.toLowerCase().startsWith(typed)) : undefined;
  return matched ?? aliases[0] ?? '';
}

function firstToken(text: string): string {
  const trimmed = text.trim();
  const boundary = trimmed.search(/\s/);
  return boundary < 0 ? trimmed : trimmed.slice(0, boundary);
}

function restOfLine(text: string): string {
  const trimmed = text.trim();
  const boundary = trimmed.search(/\s/);
  return boundary < 0 ? '' : trimmed.slice(boundary + 1).trim();
}

function prettyUrl(url: string): string {
  // The passthrough marker is plumbing, and the omnibox preview already hides
  // it; showing `&blpass=1` on every fallback row here would just look broken.
  return stripPassthrough(url).replace(/^https?:\/\//, '');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --------------------------------------------------------------- matching --

/**
 * Marks the part of the alias the query matched: the prefix when it is one,
 * otherwise the individual characters `suggest()` matched as a subsequence.
 */
function highlight(text: string, keyword: string): Node[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return [document.createTextNode(text)];

  const lower = text.toLowerCase();
  if (lower.startsWith(needle)) {
    const nodes: Node[] = [mark(text.slice(0, needle.length))];
    if (text.length > needle.length) nodes.push(document.createTextNode(text.slice(needle.length)));
    return nodes;
  }

  const hit = new Array<boolean>(text.length).fill(false);
  let i = 0;
  for (let j = 0; j < text.length && i < needle.length; j += 1) {
    if (lower[j] === needle[i]) {
      hit[j] = true;
      i += 1;
    }
  }
  // The row matched on its name or description, not on this alias.
  if (i < needle.length) return [document.createTextNode(text)];

  const nodes: Node[] = [];
  for (let start = 0; start < text.length; ) {
    let end = start + 1;
    while (end < text.length && hit[end] === hit[start]) end += 1;
    const chunk = text.slice(start, end);
    nodes.push(hit[start] ? mark(chunk) : document.createTextNode(chunk));
    start = end;
  }
  return nodes;
}

// ---------------------------------------------------------------- events ---

input.addEventListener('input', () => {
  usingKeyboard = true;
  render();
});

// Only a genuine pointer move hands the selection back to hover, and it takes
// the row actually under the cursor: `mouseenter` already fired for that row
// while the list was scrolling itself, and will not fire again.
list.addEventListener('mousemove', (event) => {
  const moved = event.screenX !== lastX || event.screenY !== lastY;
  lastX = event.screenX;
  lastY = event.screenY;
  if (!moved || !usingKeyboard) return;
  usingKeyboard = false;
  const row = (event.target as Element | null)?.closest<HTMLLIElement>('.row') ?? null;
  const index = row ? rowNodes.indexOf(row) : -1;
  if (index >= 0 && index !== selected) setSelected(index);
});

input.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      usingKeyboard = true;
      move(1);
      return;
    case 'ArrowUp':
      event.preventDefault();
      usingKeyboard = true;
      move(-1);
      return;
    case 'Enter':
      event.preventDefault();
      launch(queryFor(selected), event.metaKey || event.ctrlKey);
      return;
    case 'Tab': {
      // Shift+Tab is the only route out of the input, and a Tab that would
      // retype what is already there is a focus move, not a completion.
      if (event.shiftKey) return;
      const completed = completionFor();
      if (completed === null) return;
      event.preventDefault();
      input.value = completed;
      render();
      return;
    }
    case 'Escape':
      event.preventDefault();
      if (!input.value) {
        window.close();
        return;
      }
      input.value = '';
      render();
  }
});

// Escape has to work from the footer link too.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && event.target !== input) window.close();
});

optionsButton.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});

// ------------------------------------------------------------------ boot ---

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mark(text: string): HTMLElement {
  const node = document.createElement('mark');
  node.textContent = text;
  return node;
}

input.focus();

/** Everything that navigates awaits this; see `navigate`. */
const readyPromise = loadResolveContext().then((context) => {
  commands = context.commands;
  settings = context.settings;
  ready = true;
  // The user may already have typed while storage was loading.
  render();
});

// Attached separately so `readyPromise` still rejects for `navigate`, which
// surfaces the failure on the destination line instead of searching blindly.
readyPromise.catch((err: unknown) => {
  input.setAttribute('aria-expanded', 'false');
  list.replaceChildren(el('li', 'empty', `Could not load your shortcuts: ${errorText(err)}`));
});
