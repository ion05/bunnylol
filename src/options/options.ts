/**
 * The shortcut manager.
 *
 * Three routes, all reachable from the address bar because the `meta` handler
 * turns `bl`, `add foo …` and `set` into `options.html#help`, `#new?prefill=…`
 * and `#settings`. The hash carries its own query string (`#new?prefill=x`),
 * so routing parses the hash rather than `location.search`.
 *
 * Every string that reaches the DOM goes through `textContent`: a shortcut name
 * is user input, and this page renders it next to the URL it will navigate to.
 */

import { BUILTIN_COMMANDS, SEARCH_ENGINES, destinationOf } from '../lib/commands';
import type { Draft } from '../lib/draft';
import { parseKeys, parsePrefill, splitKeys, withScheme } from '../lib/draft';
import { AI_PROVIDERS } from '../lib/handlers';
import { mintUserId, shortcutId } from '../lib/overrides';
import { activeKeywords, mergeCommands, resolve, stripPassthrough, suggest } from '../lib/resolve';
import {
  applyImport,
  exportJson,
  importJson,
  loadState,
  normalizeCategory,
  onStateChanged,
  saveOverrides,
  saveSettings,
  saveState,
} from '../lib/storage';
import type { ImportedState } from '../lib/storage';
import { clone, errorText, stripScheme } from '../lib/text';
import { isInterceptableAlias } from '../lib/validate';
import type {
  BgMessage,
  Category,
  Command,
  Overrides,
  RuleStatus,
  SearchEngineId,
  Settings,
  StoredState,
} from '../lib/types';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
} from '../lib/types';
import { el, nextId } from '../ui/dom';
import { PILL_CLASS, pillView, statusCount } from './status';

type RouteName = 'help' | 'new' | 'edit' | 'settings';

interface Route {
  name: RouteName;
  params: URLSearchParams;
}

/** A browse row. Disabled builtins are missing from the merged list, so the
 *  browse view is built from the raw registry plus the override layer. */
interface Entry {
  /** Stable identity for the override layer: `shortcutId`. */
  id: string;
  /** Key the merged command answers to, used to line rows up with `suggest()`. */
  matchKey: string;
  cmd: Command;
  disabled: boolean;
}

type FormField = 'keys' | 'url' | 'searchUrl';

/** Form order, which is also the order `submit()` hunts for the field to focus. */
const FORM_FIELDS: FormField[] = ['keys', 'url', 'searchUrl'];

interface Problem {
  level: 'error' | 'warn';
  text: string;
  field?: FormField;
}

interface Notice {
  tone: 'ok' | 'error';
  text: string;
}

interface RowRef {
  matchKey: string;
  haystack: string;
  order: number;
  node: HTMLElement;
}

interface GroupRef {
  node: HTMLElement;
  count: HTMLElement;
  rows: RowRef[];
}

const ENGINE_PRESETS: { label: string; template: string }[] = [
  { label: 'Google', template: 'https://www.google.com/search?q={q}' },
  { label: 'Bing', template: 'https://www.bing.com/search?q={q}' },
  { label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={q}' },
  { label: 'Kagi', template: 'https://kagi.com/search?q={q}' },
  { label: 'Brave Search', template: 'https://search.brave.com/search?q={q}' },
];

const root = document.getElementById('app') ?? document.body;

let stored: StoredState = { overrides: clone(DEFAULT_OVERRIDES), settings: clone(DEFAULT_SETTINGS) };
let commands: Command[] = mergeCommands(BUILTIN_COMMANDS, stored.overrides);
let route: Route = { name: 'help', params: new URLSearchParams() };
let lastRoute: RouteName | null = null;
let status: RuleStatus | null = null;
let statusBusy = false;
let statusHost: HTMLElement | null = null;
let suppressedHost: HTMLElement | null = null;
let resyncButton: HTMLButtonElement | null = null;
let notice: Notice | null = null;
let browseFilter = '';
let sampleArgs = 'example query';
let statusTimer = 0;

void boot();

async function boot(): Promise<void> {
  applyState(await loadState());
  route = parseRoute(location.hash);
  browseFilter = route.name === 'help' ? (route.params.get('q') ?? '') : '';
  render();

  window.addEventListener('hashchange', () => {
    route = parseRoute(location.hash);
    if (route.name === 'help' && route.params.has('q')) browseFilter = route.params.get('q') ?? '';
    render();
  });

  window.addEventListener('keydown', onGlobalKey);

  onStateChanged((next) => {
    // Our own writes come straight back through this listener. Comparing
    // against what we already applied optimistically is what tells the echo
    // apart from a change made in the popup or another window.
    const echo = JSON.stringify(next) === JSON.stringify(stored);
    applyState(next);
    if (echo) return;
    // Re-rendering under a half-typed shortcut would discard it; `applyState`
    // has already refreshed what the preview and the validator read.
    if (route.name === 'new' || route.name === 'edit') return;
    // Same hazard on every other route: the settings fields only commit on
    // blur, so repainting the one the user is inside throws their text away.
    if (isTextEntry(document.activeElement)) return;
    render();
  });

  void refreshStatus();
}

function applyState(next: StoredState): void {
  stored = next;
  commands = mergeCommands(BUILTIN_COMMANDS, next.overrides);
}

function isTextEntry(node: Element | null): boolean {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement
  );
}

function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const split = raw.indexOf('?');
  const head = (split < 0 ? raw : raw.slice(0, split)).trim().toLowerCase();
  const params = new URLSearchParams(split < 0 ? '' : raw.slice(split + 1));
  const name: RouteName =
    head === 'new' || head === 'add'
      ? 'new'
      : head === 'edit'
        ? 'edit'
        : head === 'settings' || head === 'set'
          ? 'settings'
          : 'help';
  return { name, params };
}

function go(hash: string): void {
  if (location.hash === hash) {
    route = parseRoute(hash);
    render();
    return;
  }
  location.hash = hash;
}

function onGlobalKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement;

  if (event.key === 'Escape' && (route.name === 'new' || route.name === 'edit')) {
    event.preventDefault();
    go('#help');
    return;
  }
  if (event.key === '/' && route.name === 'help' && !typing) {
    const filter = document.getElementById('filter');
    if (filter instanceof HTMLInputElement) {
      event.preventDefault();
      filter.focus();
      filter.select();
    }
  }
}

// ---------------------------------------------------------------- render ----

function render(): void {
  const scroll = window.scrollY;
  const sameRoute = lastRoute === route.name;
  lastRoute = route.name;

  // Live-region hosts belong to the nodes about to be thrown away; whoever
  // renders next re-claims them.
  suppressedHost = null;
  root.textContent = '';
  const shell = el('main', { class: 'shell' });
  shell.append(...renderView());
  root.append(renderTopbar(), shell);
  paintStatus();
  window.scrollTo({ top: sameRoute ? scroll : 0 });
}

function renderView(): Node[] {
  if (route.name === 'settings') return renderSettings();
  if (route.name === 'new' || route.name === 'edit') return [renderForm()];
  return renderBrowse();
}

function renderTopbar(): HTMLElement {
  statusHost = el('span', { class: 'pill', attrs: { role: 'status', 'aria-live': 'polite' } });
  resyncButton = button('Re-sync', () => void resync(), 'btn btn-sm');
  resyncButton.title = 'Rebuild the redirect rules from your current shortcuts';

  const brand = el('div', {
    class: 'brand',
    children: [
      el('h1', { class: 'brand-name', text: 'BunnyLol' }),
      el('span', { class: 'brand-tag', text: 'keyword shortcuts for the address bar' }),
    ],
  });

  const nav = el('nav', { class: 'nav', attrs: { 'aria-label': 'Sections' } });
  const tabs: { hash: string; label: string; match: RouteName[] }[] = [
    { hash: '#help', label: 'Shortcuts', match: ['help'] },
    { hash: '#new', label: 'New shortcut', match: ['new', 'edit'] },
    { hash: '#settings', label: 'Settings', match: ['settings'] },
  ];
  for (const tab of tabs) {
    const link = el('a', { class: 'nav-link', text: tab.label });
    link.href = tab.hash;
    if (tab.match.includes(route.name)) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }

  return el('header', {
    class: 'topbar',
    children: [
      el('div', {
        class: 'topbar-inner',
        children: [
          brand,
          el('div', { class: 'status', children: [statusHost, resyncButton] }),
          nav,
        ],
      }),
    ],
  });
}

// ------------------------------------------------------------ rule status ----

function paintStatus(): void {
  paintSuppressed();
  const host = statusHost;
  if (!host) return;
  const view = pillView({
    status,
    busy: statusBusy,
    engineCount: stored.settings.interceptEngines.length,
  });

  host.textContent = '';
  host.className = PILL_CLASS[view.tone];
  host.append(el('span', { class: 'pill-dot' }), el('span', { text: view.text }));
  if (view.detail) {
    host.append(el('span', { class: 'pill-detail muted', text: view.detail, title: view.detail }));
  }

  if (resyncButton) resyncButton.disabled = statusBusy;
}

async function refreshStatus(): Promise<void> {
  status = await readStatus({ type: 'getRuleStatus' });
  paintStatus();
}

async function resync(): Promise<void> {
  statusBusy = true;
  paintStatus();
  status = await readStatus({ type: 'resyncRules' });
  statusBusy = false;
  paintStatus();
}

async function readStatus(message: BgMessage): Promise<RuleStatus> {
  try {
    const reply = (await chrome.runtime.sendMessage(message)) as RuleStatus | undefined;
    if (!reply) throw new Error('The background service worker did not respond.');
    return reply;
  } catch (err) {
    const offline: RuleStatus = {
      registered: 0,
      keywords: 0,
      suppressed: 0,
      dropped: 0,
      error: errorText(err),
      warning: null,
      extensionId: runtimeId(),
    };
    return offline;
  }
}

/** The background is the source of truth for the id, but the page can be open
 *  before the first status reply lands. */
function runtimeId(): string {
  return typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : '';
}

function scheduleStatusRefresh(): void {
  // The worker re-syncs on the storage change we just wrote; give it a beat so
  // the pill reports the new rule count rather than the old one.
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => void refreshStatus(), 500);
}

// ------------------------------------------------------------------ browse ----

function renderBrowse(): Node[] {
  const entries = browseEntries();
  // The same list the DNR rules are built from, so the marker below cannot
  // drift from what the address bar actually does.
  const intercepted = new Set(activeKeywords(commands, stored.settings.interceptStopList));
  const nodes: Node[] = [];

  const shown = notice;
  notice = null;
  // A stale filter would hide the very shortcut the notice is about.
  if (shown) browseFilter = '';
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
  filter.value = browseFilter;

  const count = el('p', { class: 'count', attrs: { role: 'status', 'aria-live': 'polite' } });
  const groups = el('div', { class: 'groups' });
  const empty = el('div', { class: 'empty' });
  empty.hidden = true;

  const groupRefs: GroupRef[] = [];
  /** Rows whose shortcut was deleted; their nodes are gone from the DOM but
   *  they are still listed in `groupRefs`, and the counts must skip them. */
  const removed = new WeakSet<HTMLElement>();

  for (const category of groupOrder(entries)) {
    const inGroup = entries.filter((entry) => entry.cmd.category === category);
    if (inGroup.length === 0) continue;

    const countNode = el('span', { class: 'group-count', text: String(inGroup.length) });
    const rows = el('div', { class: 'rows' });
    const group = el('section', {
      class: 'group',
      children: [
        el('div', {
          class: 'group-head',
          children: [
            el('h2', { class: 'group-title', text: CATEGORY_LABELS[category] }),
            countNode,
          ],
        }),
        rows,
      ],
    });

    const ref: GroupRef = { node: group, count: countNode, rows: [] };
    inGroup.forEach((entry, index) => {
      const node = renderRow(entry, intercepted, (deleted) => {
        removed.add(deleted);
        applyFilter();
      });
      rows.append(node);
      ref.rows.push({
        matchKey: entry.matchKey,
        haystack: haystackOf(entry.cmd),
        order: index,
        node,
      });
    });
    groupRefs.push(ref);
    groups.append(group);
  }

  const panel = el('section', {
    class: 'panel',
    children: [
      el('div', {
        class: 'toolbar',
        children: [el('div', { class: 'search-field', children: [filter] }), count],
      }),
      groups,
      empty,
    ],
  });

  function applyFilter(): void {
    const query = filter.value.trim().toLowerCase();
    browseFilter = filter.value;

    // `suggest()` gives keyword-first ranking; the substring pass then widens it
    // to descriptions so the box behaves like a filter and not just a launcher.
    const ranks = new Map<string, number>();
    if (query) {
      suggest(query, commands, commands.length).forEach((cmd, index) => {
        const key = firstKey(cmd);
        if (!ranks.has(key)) ranks.set(key, index);
      });
    }

    let visible = 0;
    let total = 0;
    for (const group of groupRefs) {
      let inGroup = 0;
      for (const row of group.rows) {
        if (removed.has(row.node)) continue;
        total += 1;
        const rank = ranks.get(row.matchKey);
        const match = !query || rank !== undefined || row.haystack.includes(query);
        row.node.hidden = !match;
        // Reordering with `order` keeps the DOM untouched, so filtering ~170
        // rows costs a style recalc instead of a re-render.
        row.node.style.order = String(rank ?? (query ? 10000 + row.order : row.order));
        if (match) inGroup += 1;
      }
      group.count.textContent = String(inGroup);
      group.node.hidden = inGroup === 0;
      visible += inGroup;
    }

    count.textContent = query ? `${visible} of ${total} shortcuts` : `${total} shortcuts`;

    empty.textContent = '';
    empty.hidden = visible > 0;
    if (visible === 0) {
      empty.append(
        el('p', { text: `Nothing matches “${filter.value.trim()}”.` }),
        el('div', {
          class: 'btn-row',
          children: [
            button(
              'Create a shortcut for it',
              () => go(`#new?prefill=${encodeURIComponent(filter.value.trim())}`),
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

function groupOrder(entries: Entry[]): Category[] {
  // The user's own shortcuts lead: they are the reason this page exists, and
  // they are the ones that need editing.
  const hasCustom = entries.some((entry) => entry.cmd.category === 'custom');
  const rest = CATEGORIES.filter((category) => category !== 'custom');
  return hasCustom ? ['custom', ...rest] : rest;
}

function browseEntries(): Entry[] {
  const disabled = new Set(stored.overrides.disabled.map((key) => key.trim().toLowerCase()));
  const entries: Entry[] = stored.overrides.custom.map((cmd) => ({
    id: shortcutId(cmd),
    matchKey: firstKey(cmd),
    cmd,
    disabled: false,
  }));

  for (const cmd of BUILTIN_COMMANDS) {
    const id = shortcutId(cmd);
    const override = stored.overrides.keyOverrides[id] ?? [];
    const keys = override.length > 0 ? override : cmd.keys;
    entries.push({
      id,
      matchKey: (keys[0] ?? id).trim().toLowerCase(),
      cmd: { ...cmd, keys },
      disabled: disabled.has(id),
    });
  }
  return entries;
}

function haystackOf(cmd: Command): string {
  const destinations = `${cmd.url} ${cmd.searchUrl ?? ''}`;
  return `${cmd.keys.join(' ')} ${cmd.name} ${cmd.description} ${destinations}`.toLowerCase();
}

/** The aliases exempted through `interceptStopList`, lowercased. */
function stopSet(): Set<string> {
  return new Set((stored.settings.interceptStopList ?? []).map((key) => key.trim().toLowerCase()));
}

/** Persisted examples win; the rest are derived so a sample argument typed into
 *  the preview never becomes permanent label text. */
function exampleOf(cmd: Command): string {
  if (cmd.example) return cmd.example;
  const key = cmd.keys[0];
  if (cmd.builtin || !key || !cmd.searchUrl) return '';
  return `${key} <arguments>`;
}

function renderRow(
  entry: Entry,
  intercepted: Set<string>,
  onRemoved: (row: HTMLElement) => void,
): HTMLElement {
  const row = el('div', { class: entry.disabled ? 'row off' : 'row' });

  const keys = el('div', { class: 'row-keys' });
  const paintKeys = (list: string[]): void => {
    keys.textContent = '';
    for (const key of list) keys.append(el('code', { class: 'chip', text: key }));
  };
  paintKeys(entry.cmd.keys);

  const name = el('div', { class: 'row-name', text: entry.cmd.name });
  if (!entry.cmd.builtin) name.append(el('span', { class: 'badge', text: 'yours' }));
  // The row is dimmed rather than greyed out, so the off state needs a label
  // that does not depend on noticing a colour.
  const offBadge = el('span', { class: 'badge badge-quiet', text: 'off' });
  offBadge.title = 'Turned off. It resolves nowhere until you switch it back on.';
  offBadge.hidden = !entry.disabled;
  name.append(offBadge);
  if (!entry.disabled && !entry.cmd.keys.some((key) => intercepted.has(key))) {
    const marker = el('span', { class: 'badge badge-quiet', text: 'omnibox only' });
    marker.title =
      'Not intercepted in the address bar. Type bl, press Tab, then the keyword — or use the popup.';
    name.append(marker);
  }

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

  if (entry.cmd.builtin) {
    // Built on demand: pre-rendering a hidden rebind form under every one of
    // ~170 rows is a lot of DOM for a control most rows never open.
    let editor: HTMLElement | null = null;
    actions.append(
      button('Keys', () => {
        if (editor) editor.hidden = !editor.hidden;
        else {
          editor = renderKeyEditor(entry, row, paintKeys);
          row.append(editor);
        }
        const open: HTMLElement = editor;
        if (!open.hidden) open.querySelector('input')?.focus();
      }, 'btn btn-sm btn-ghost'),
      switchControl(`Enable ${entry.cmd.name}`, !entry.disabled, (on) => {
        const next = stored.overrides.disabled.filter((key) => key !== entry.id);
        if (!on) next.push(entry.id);
        row.classList.toggle('off', !on);
        offBadge.hidden = on;
        void commitOverrides({ ...stored.overrides, disabled: next }).catch(reportFailure);
      }),
    );
  } else {
    actions.append(
      button('Edit', () => go(`#edit?key=${encodeURIComponent(entry.id)}`), 'btn btn-sm'),
      confirmButton('Delete', 'Click again to confirm', 'btn btn-sm btn-danger', () => {
        const custom = stored.overrides.custom.filter((cmd) => shortcutId(cmd) !== entry.id);
        void commitOverrides({ ...stored.overrides, custom }).catch(reportFailure);
        row.remove();
        onRemoved(row);
      }),
    );
  }

  return row;
}

/** Rebinding a builtin writes `keyOverrides[canonical]`; the builtin itself is
 *  never mutated, so "Reset" is just dropping the entry. */
function renderKeyEditor(
  entry: Entry,
  row: HTMLElement,
  paintKeys: (keys: string[]) => void,
): HTMLElement {
  const input = el('input', {
    class: 'input mono',
    attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off' },
  });
  input.value = entry.cmd.keys.join(', ');
  const label = el('label', {
    class: 'visually-hidden',
    text: `Keywords for ${entry.cmd.name}`,
  });
  label.htmlFor = input.id || (input.id = nextId('keys'));

  const message = el('span', { class: 'msg msg-error' });
  message.hidden = true;
  const warning = el('span', { class: 'msg msg-warn' });
  warning.hidden = true;

  const editor = el('div', { class: 'row-editor' });

  // Cancel and Escape have to agree: leaving the edited text in the box after
  // Cancel reads as "saved" the next time the editor is opened.
  const close = (): void => {
    input.value = entry.cmd.keys.join(', ');
    editor.hidden = true;
    message.hidden = true;
    warning.hidden = true;
  };

  const fail = (text: string): void => {
    message.textContent = text;
    message.hidden = false;
    // A warning from a previous save reads as the outcome of this one.
    warning.hidden = true;
  };

  const save = (): void => {
    // The same validator the new-shortcut form and the import path use. An
    // alias it rejects is unreachable from every surface, not merely
    // un-intercepted, so it must not be saved at all.
    const parsed = parseKeys(input.value);
    if (!parsed.ok) return fail(parsed.reason);

    const keys = parsed.keys;
    if (keys.length === 0) {
      return fail('Enter at least one keyword, or use Reset to restore the default.');
    }
    const owners = buildKeyOwner();
    const clash = keys.find((key) => {
      const owner = owners.get(key);
      return owner !== undefined && owner !== entry.id;
    });
    if (clash) {
      return fail(`“${clash}” is already taken by ${describeOwner(owners.get(clash) ?? '')}.`);
    }

    const keyOverrides = { ...stored.overrides.keyOverrides, [entry.id]: keys };
    entry.cmd = { ...entry.cmd, keys };
    entry.matchKey = keys[0];
    paintKeys(keys);
    reset.hidden = false;
    void commitOverrides({ ...stored.overrides, keyOverrides }).catch(reportFailure);

    // Non-blocking, and the same copy `validate()` uses: the rebind is saved
    // and the keyword resolves everywhere the resolver runs; it is only the
    // address-bar redirect that cannot carry it. Leaving the editor open is
    // what makes the warning visible at all.
    const blocked = keys.filter((key) => !isInterceptableAlias(key) || stopSet().has(key));
    if (blocked.length > 0) {
      warning.textContent = `Saved, but “${blocked.join('”, “')}” ${blocked.length === 1 ? 'is' : 'are'} not intercepted in the address bar — typing ${blocked.length === 1 ? 'it' : 'them'} there runs a normal search. ${blocked.length === 1 ? 'It still works' : 'They still work'} from the toolbar popup and from bl + Tab.`;
      warning.hidden = false;
      message.hidden = true;
      return;
    }
    close();
    row.querySelector<HTMLButtonElement>('.row-actions .btn')?.focus();
  };

  const reset = button('Reset', () => {
    const keyOverrides = { ...stored.overrides.keyOverrides };
    delete keyOverrides[entry.id];
    const original = BUILTIN_COMMANDS.find((cmd) => shortcutId(cmd) === entry.id)?.keys ?? entry.cmd.keys;
    entry.cmd = { ...entry.cmd, keys: original };
    entry.matchKey = (original[0] ?? entry.id).toLowerCase();
    input.value = original.join(', ');
    paintKeys(original);
    void commitOverrides({ ...stored.overrides, keyOverrides }).catch(reportFailure);
    close();
  }, 'btn btn-sm');
  reset.hidden = !(stored.overrides.keyOverrides[entry.id]?.length);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });

  editor.append(
    label,
    input,
    button('Save keywords', save, 'btn btn-sm btn-primary'),
    reset,
    button('Cancel', close, 'btn btn-sm btn-ghost'),
    message,
    warning,
  );
  return editor;
}

/** alias -> owning command id, across everything currently active. */
function buildKeyOwner(): Map<string, string> {
  const owner = new Map<string, string>();
  for (const entry of browseEntries()) {
    if (entry.disabled) continue;
    for (const key of entry.cmd.keys) {
      const alias = key.trim().toLowerCase();
      if (alias && !owner.has(alias)) owner.set(alias, entry.id);
    }
  }
  return owner;
}

function describeOwner(id: string): string {
  const entry = browseEntries().find((candidate) => candidate.id === id);
  if (!entry) return `“${id}”`;
  return `${entry.cmd.name} (${entry.cmd.builtin ? 'built in' : 'your shortcut'})`;
}

// -------------------------------------------------------------------- form ----

function renderForm(): HTMLElement {
  const editingKey = route.name === 'edit' ? (route.params.get('key') ?? '').toLowerCase() : '';
  const existing = editingKey
    ? stored.overrides.custom.find((cmd) => shortcutId(cmd) === editingKey)
    : undefined;
  const editing = existing ? editingKey : '';

  const draft: Draft = existing
    ? {
        keys: existing.keys.join(', '),
        name: existing.name,
        description: existing.description,
        url: existing.url,
        searchUrl: existing.searchUrl ?? '',
        category: existing.category,
        example: '',
        newSectionLabel: '',
      }
    : parsePrefill(route.params.get('prefill') ?? '');

  const keysInput = textInput(draft.keys, 'gh, github', true);
  const nameInput = textInput(draft.name, 'GitHub');
  const descInput = textInput(draft.description, 'Open a repo, or search GitHub.');
  const urlInput = textInput(draft.url, 'https://github.com', true);
  const searchInput = textInput(draft.searchUrl, 'https://github.com/search?q={q}', true);
  const categorySelect = selectControl(
    CATEGORIES.map((category) => ({ value: category, label: CATEGORY_LABELS[category] })),
    draft.category,
  );

  const sampleInput = textInput(sampleArgs, 'arguments');
  sampleInput.setAttribute('aria-label', 'Sample arguments for the preview');
  const previewRows = el('div', { class: 'preview-rows' });
  const previewNote = el('p', { class: 'field-hint' });
  previewNote.hidden = true;

  const messages = el('div', { class: 'msg-list', attrs: { 'aria-live': 'polite' } });
  const saveButton = button('Save shortcut', () => void submit(), 'btn btn-primary');

  const inputs: Record<FormField, HTMLInputElement> = {
    keys: keysInput,
    url: urlInput,
    searchUrl: searchInput,
  };
  const slots: Record<FormField, FieldSlot> = {
    keys: errorField(
      'Keywords',
      keysInput,
      'err-keys',
      'Comma-separated. The first one is canonical.',
    ),
    url: errorField('Destination URL', urlInput, 'err-url', 'Where the bare keyword goes.', true),
    searchUrl: errorField(
      'Search URL',
      searchInput,
      'err-searchurl',
      'Optional. Put {q} where the arguments belong. Without it, BunnyLol appends ?q=…',
      true,
    ),
  };

  /** A pristine form is not a wrong form: a field's problems stay hidden until
   *  the user has been in it, or until they ask to save. */
  const touched = new Set<FormField>();
  let submitted = false;
  for (const name of FORM_FIELDS) {
    inputs[name].addEventListener('input', () => touched.add(name));
    inputs[name].addEventListener('blur', () => {
      // An empty field the user only tabbed through has not been answered
      // wrongly yet; the autofocused one would otherwise turn red on the very
      // first click anywhere on the page.
      if (touched.has(name) || !inputs[name].value.trim()) return;
      touched.add(name);
      recompute();
    });
  }

  const form = el('div', { class: 'form' });
  form.append(
    slots.keys.node,
    field('Name', nameInput, 'Shown in this list and in the omnibox dropdown.'),
    field(
      'Description',
      descInput,
      'Optional. One line explaining what the shortcut does.',
      true,
    ),
    slots.url.node,
    slots.searchUrl.node,
    field('Category', categorySelect, 'Only affects grouping on this page.'),
  );

  const preview = el('div', {
    class: 'preview',
    children: [
      el('div', {
        class: 'preview-head',
        children: [
          el('h3', { text: 'Live preview' }),
          el('div', {
            class: 'preview-sample',
            children: [el('span', { text: 'sample arguments' }), sampleInput],
          }),
        ],
      }),
      previewRows,
    ],
  });

  const panel = el('section', { class: 'panel' });
  panel.append(
    el('div', {
      class: 'panel-head',
      children: [
        el('div', {
          class: 'panel-head-text',
          children: [
            el('h2', {
              class: 'panel-title',
              text: editing ? `Edit ${existing?.name ?? 'shortcut'}` : 'New shortcut',
            }),
            el('p', {
              class: 'panel-sub',
              text: 'Type a keyword and a destination. The preview below is the real resolver — what it shows is exactly where the address bar will land.',
            }),
          ],
        }),
      ],
    }),
    el('div', {
      class: 'panel-body',
      children: [
        form,
        preview,
        previewNote,
        messages,
        el('div', {
          class: 'form-actions',
          children: [
            saveButton,
            button('Cancel', () => go('#help'), 'btn'),
            el('span', { class: 'spacer' }),
            el('span', { class: 'field-hint', text: 'Escape closes without saving.' }),
          ],
        }),
      ],
    }),
  );

  function readDraft(): Draft {
    return {
      keys: keysInput.value,
      name: nameInput.value,
      description: descInput.value,
      url: urlInput.value,
      searchUrl: searchInput.value,
      category: categorySelect.value,
      example: '',
      newSectionLabel: '',
    };
  }

  function recompute(): void {
    const current = readDraft();
    const problems = validate(current, editing);
    // The pooled list carries only what no single field owns.
    paintProblems(messages, problems.filter((problem) => problem.field === undefined));
    for (const name of FORM_FIELDS) {
      const visible = submitted || touched.has(name);
      slots[name].setProblems(
        visible ? problems.filter((problem) => problem.field === name) : [],
      );
    }
    paintPreview(current, editing, previewRows, previewNote);
  }

  async function submit(): Promise<void> {
    submitted = true;
    const current = readDraft();
    const problems = validate(current, editing);
    recompute();
    if (problems.some((problem) => problem.level === 'error')) {
      const offending = FORM_FIELDS.find((name) =>
        problems.some((problem) => problem.level === 'error' && problem.field === name),
      );
      if (offending) inputs[offending].focus();
      return;
    }
    const cmd = buildCommand(current);
    const custom = editing
      ? stored.overrides.custom.map((existingCmd) =>
          // The id is carried across explicitly: a shortcut whose keys changed is
          // still the same shortcut, and `buildCommand` only knows the form.
          shortcutId(existingCmd) === editing ? { ...cmd, id: editing } : existingCmd,
        )
      : [
          ...stored.overrides.custom,
          // Minted here rather than left to `saveOverrides`: the row this
          // render puts on screen needs a real id for its Edit and Delete
          // links, and an optimistic copy without one no longer matches the
          // blob that comes back through `onStateChanged`, costing a full
          // repaint on every new shortcut. Storage honours a `u:` claim, and
          // minting is deterministic, so it mints the same id we did.
          {
            ...cmd,
            id: mintUserId(cmd.keys[0] ?? '', new Set(stored.overrides.custom.map(shortcutId))),
          },
        ];
    try {
      await commitOverrides({ ...stored.overrides, custom });
    } catch (err) {
      paintProblems(messages, [{ level: 'error', text: `Could not save: ${errorText(err)}` }]);
      return;
    }
    notice = { tone: 'ok', text: `Saved “${cmd.name}”. Type ${cmd.keys[0]} in the address bar to use it.` };
    go('#help');
  }

  panel.addEventListener('input', (event) => {
    if (event.target === sampleInput) sampleArgs = sampleInput.value;
    recompute();
  });
  recompute();
  window.setTimeout(() => keysInput.focus(), 0);

  return panel;
}

function paintProblems(host: HTMLElement, problems: Problem[]): void {
  host.textContent = '';
  for (const problem of problems) {
    host.append(
      el('p', {
        class: problem.level === 'error' ? 'msg msg-error' : 'msg msg-warn',
        text: problem.text,
      }),
    );
  }
}

function paintPreview(
  draft: Draft,
  editing: string,
  rows: HTMLElement,
  note: HTMLElement,
): void {
  rows.textContent = '';
  note.hidden = true;

  const keys = splitKeys(draft.keys);
  if (keys.length === 0 || !draft.url.trim()) {
    rows.append(
      el('div', {
        class: 'preview-row',
        children: [
          el('span', { class: 'preview-typed faint', text: 'a keyword and a URL' }),
          el('span', { class: 'preview-arrow', text: '→' }),
          el('span', { class: 'preview-url faint', text: 'nothing to preview yet' }),
        ],
      }),
    );
    return;
  }

  const cmd = buildCommand(draft);
  const previewCommands = mergeCommands(BUILTIN_COMMANDS, previewOverrides(cmd, editing));
  const key = keys[0];
  const withArgs = sampleArgs.trim() ? `${key} ${sampleArgs.trim()}` : key;

  for (const typed of withArgs === key ? [key] : [key, withArgs]) {
    const result = resolve(typed, previewCommands, stored.settings);
    // Same as the omnibox and the popup: the passthrough marker is plumbing.
    const shown = stripPassthrough(result.url);
    rows.append(
      el('div', {
        class: 'preview-row',
        children: [
          el('span', { class: 'preview-typed', text: typed }),
          el('span', { class: 'preview-arrow', text: '→' }),
          el('span', {
            class: result.fallback ? 'preview-url is-fallback' : 'preview-url',
            text: shown,
            title: shown,
          }),
        ],
      }),
    );
    // A key already owned by an earlier command means this preview is showing
    // somebody else's destination, which is worth spelling out.
    if (result.command && result.command.name !== cmd.name) {
      note.textContent = `“${key}” currently resolves to ${result.command.name}, not this shortcut.`;
      note.hidden = false;
    }
  }
}

function previewOverrides(draft: Command, editing: string): Overrides {
  const custom = editing
    ? stored.overrides.custom.map((cmd) => (shortcutId(cmd) === editing ? draft : cmd))
    : [...stored.overrides.custom, draft];
  return { ...stored.overrides, custom };
}

function buildCommand(draft: Draft): Command {
  const parsed = parseKeys(draft.keys);
  // The live preview builds a command while the form is still being typed into,
  // so a rejected alias falls back to the raw split rather than blanking the row.
  const keys = parsed.ok ? parsed.keys : splitKeys(draft.keys);
  const cmd: Command = {
    keys,
    name: draft.name.trim() || keys[0] || 'Untitled',
    description: draft.description.trim(),
    url: withScheme(draft.url),
    // `Draft.category` is an open id; the registry's is not. Narrow it through
    // the same check storage applies to a stored blob rather than casting.
    category: normalizeCategory(draft.category),
    builtin: false,
  };
  const searchUrl = draft.searchUrl.trim();
  if (searchUrl) cmd.searchUrl = withScheme(searchUrl);
  // No `example`: it is derived from the keys at render time by `exampleOf`,
  // so a throwaway value typed into the preview never becomes label text.
  return cmd;
}

function validate(draft: Draft, editing: string): Problem[] {
  const problems: Problem[] = [];
  const parsed = parseKeys(draft.keys);
  const keys = parsed.ok ? parsed.keys : [];

  if (!parsed.ok) {
    problems.push({ level: 'error', field: 'keys', text: parsed.reason });
  } else if (keys.length === 0) {
    problems.push({
      level: 'error',
      field: 'keys',
      text: 'Add at least one keyword — that is what you type in the address bar.',
    });
  }
  for (const key of keys) {
    if (!isInterceptableAlias(key)) {
      problems.push({
        level: 'warn',
        field: 'keys',
        text: `“${key}” is not intercepted in the address bar — typing it there runs a normal search. It still works from the toolbar popup and from bl + Tab.`,
      });
    }
  }

  const owner = buildKeyOwner();
  const mine = new Map(
    stored.overrides.custom.map((cmd) => [shortcutId(cmd), cmd] as const),
  );
  for (const key of keys) {
    const ownerId = owner.get(key);
    if (!ownerId || ownerId === editing) continue;
    const clash = mine.get(ownerId);
    if (clash) {
      problems.push({
        level: 'error',
        field: 'keys',
        text: `“${key}” is already used by your shortcut “${clash.name}”. Pick another keyword, or edit that one instead.`,
      });
    } else {
      const builtin = BUILTIN_COMMANDS.find((cmd) => shortcutId(cmd) === ownerId);
      const spare = (builtin?.keys ?? []).filter((alias) => alias.toLowerCase() !== key);
      problems.push({
        level: 'warn',
        field: 'keys',
        text: spare.length
          ? `“${key}” currently opens ${builtin?.name ?? ownerId}. Your shortcut will take over; that one stays reachable as ${spare.join(', ')}.`
          : `“${key}” currently opens ${builtin?.name ?? ownerId}. Your shortcut will take over and that one loses its only keyword.`,
      });
    }
  }

  if (!draft.url.trim()) {
    problems.push({
      level: 'error',
      field: 'url',
      text: 'Destination URL is required — a bare keyword has to go somewhere.',
    });
  } else {
    const problem = urlProblem(withScheme(draft.url), 'Destination URL', 'url');
    if (problem) problems.push(problem);
  }

  const searchUrl = draft.searchUrl.trim();
  if (searchUrl) {
    const problem = urlProblem(withScheme(searchUrl), 'Search URL', 'searchUrl');
    if (problem) problems.push(problem);
    else if (!searchUrl.includes('{q}') && !searchUrl.includes('%s')) {
      problems.push({
        level: 'warn',
        field: 'searchUrl',
        text: 'Search URL has no {q}, so BunnyLol will append the arguments as ?q=… Add {q} to place them yourself.',
      });
    }
  }

  return problems;
}

function urlProblem(value: string, label: string, field: FormField): Problem | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { level: 'error', field, text: `${label} is not a valid URL.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { level: 'error', field, text: `${label} must start with http:// or https://.` };
  }
  return null;
}

/**
 * Stricter than `urlProblem`, because this one field swallows every unmatched
 * search on all three surfaces: `gogle/search?q={q}` parses as a URL with the
 * host `gogle`, and no scheme is added for the user here — silently rewriting
 * what they typed is how a typo becomes the live default engine.
 */
function engineProblem(value: string): Problem | null {
  const label = 'Fallback URL template';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return {
      level: 'error',
      field: 'url',
      text: `${label} has no scheme. Start it with https:// so it is clear where the search goes.`,
    };
  }
  const problem = urlProblem(value, label, 'url');
  if (problem) return problem;

  const host = new URL(value).hostname;
  if (/[{}]/.test(host)) {
    return {
      level: 'error',
      field: 'url',
      text: `“${host}” is not a host name. A placeholder belongs in the path or the query string, not in the domain.`,
    };
  }
  // `localhost` is the one single-label host a self-hosted engine really uses;
  // anything else without a dot is a typo, and a typo here breaks every search.
  if (!host.includes('.') && host !== 'localhost') {
    return {
      level: 'error',
      field: 'url',
      text: `“${host}” is not a full domain name. Use something like https://example.com/search?q={q}.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------- settings ----

function renderSettings(): Node[] {
  return [
    renderDefaults(),
    renderInterception(),
    renderStopList(),
    renderAiTemplates(),
    renderData(),
  ];
}

function renderDefaults(): HTMLElement {
  const card = panelCard(
    'Defaults',
    'Values the smart handlers read: your GitHub user, where unmatched queries go, and which account Google links use.',
  );

  const githubInput = textInput(stored.settings.githubUser, 'octocat');
  githubInput.addEventListener('change', () => {
    void commitSettings({ ...stored.settings, githubUser: githubInput.value.trim() }, card.saved);
  });

  const engineInput = textInput(stored.settings.defaultEngine, DEFAULT_SETTINGS.defaultEngine, true);
  const engineField = errorField(
    'Fallback URL template',
    engineInput,
    'err-engine',
    'Anything with {q} works, so a self-hosted or region-specific engine is one paste away.',
    true,
  );
  const enginePreset = selectControl(
    [
      ...ENGINE_PRESETS.map((preset) => ({ value: preset.template, label: preset.label })),
      { value: 'custom', label: 'Custom…' },
    ],
    ENGINE_PRESETS.some((preset) => preset.template === stored.settings.defaultEngine)
      ? stored.settings.defaultEngine
      : 'custom',
  );

  const syncPreset = (value: string): void => {
    enginePreset.value = ENGINE_PRESETS.some((preset) => preset.template === value)
      ? value
      : 'custom';
  };

  enginePreset.addEventListener('change', () => {
    if (enginePreset.value === 'custom') {
      engineInput.focus();
      engineInput.select();
      return;
    }
    engineInput.value = enginePreset.value;
    engineField.setProblems([]);
    void commitSettings({ ...stored.settings, defaultEngine: enginePreset.value }, card.saved);
  });

  engineInput.addEventListener('change', () => {
    // This one field decides where every unmatched search on all three surfaces
    // lands, so a rejected value must not be written and must not flash "Saved".
    const value = engineInput.value.trim() || DEFAULT_SETTINGS.defaultEngine;
    const problem = engineProblem(value);
    if (problem) {
      engineField.setProblems([problem]);
      return;
    }
    engineField.setProblems(
      value.includes('{q}') || value.includes('%s')
        ? []
        : [
            {
              level: 'warn',
              field: 'url',
              text: 'No {q} in this template, so BunnyLol appends ?q=… to it. Add {q} to put the query where the engine expects it.',
            },
          ],
    );
    engineInput.value = value;
    syncPreset(value);
    void commitSettings({ ...stored.settings, defaultEngine: value }, card.saved);
  });

  // Keyed by provider id, not by alias: rebinding the Claude builtin's keyword
  // must not silently repoint `?` at somebody else.
  const aiOptions = AI_PROVIDERS.map((provider) => {
    const alias = commands.find((cmd) => cmd.provider === provider.id)?.keys[0];
    return { value: provider.id, label: alias ? `${provider.label} (${alias})` : provider.label };
  });
  if (!aiOptions.some((option) => option.value === stored.settings.defaultAi)) {
    aiOptions.unshift({ value: stored.settings.defaultAi, label: stored.settings.defaultAi });
  }
  const aiSelect = selectControl(aiOptions, stored.settings.defaultAi);
  aiSelect.addEventListener('change', () => {
    void commitSettings({ ...stored.settings, defaultAi: aiSelect.value }, card.saved);
  });

  const accountInput = el('input', {
    class: 'input',
    attrs: { type: 'number', min: '0', step: '1', inputmode: 'numeric' },
  });
  accountInput.value = String(stored.settings.googleAccount);
  accountInput.addEventListener('change', () => {
    const parsed = Math.max(0, Math.floor(Number(accountInput.value) || 0));
    accountInput.value = String(parsed);
    void commitSettings({ ...stored.settings, googleAccount: parsed }, card.saved);
  });

  card.body.append(
    el('div', {
      class: 'form',
      children: [
        field('GitHub username', githubInput, 'Used by gh me, pr and iss.'),
        field(
          'Default AI',
          aiSelect,
          'Where the ? shortcut sends your prompt. Follows the provider, not its keyword.',
        ),
        field('Fallback search engine', enginePreset, 'Used when no keyword matches.'),
        field(
          'Google account index',
          accountInput,
          'The N in /u/N/ — 0 is the account you signed in with first.',
        ),
        engineField.node,
      ],
    }),
  );
  return card.section;
}

function renderInterception(): HTMLElement {
  const card = panelCard(
    'Search interception',
    'BunnyLol watches searches on the engines below and, when one starts with a keyword you own, redirects the tab before the request leaves your machine. Uncheck an engine to leave its searches alone.',
  );

  const checks = el('div', { class: 'checks' });
  for (const engine of SEARCH_ENGINES) {
    checks.append(
      checkbox(engine.label, stored.settings.interceptEngines.includes(engine.id), (on) => {
        const set = new Set<SearchEngineId>(stored.settings.interceptEngines);
        if (on) set.add(engine.id);
        else set.delete(engine.id);
        const interceptEngines = SEARCH_ENGINES.map((item) => item.id).filter((id) => set.has(id));
        void commitSettings({ ...stored.settings, interceptEngines }, card.saved);
      }),
    );
  }

  const id = status?.extensionId || runtimeId();
  const searchUrl = `chrome-extension://${id}/go.html?q=%s`;
  const copyState = el('span', { class: 'saved' });
  const copyButton = button(
    'Copy',
    () => {
      void navigator.clipboard
        .writeText(searchUrl)
        .then(() => flash(copyState, 'Copied'))
        .catch(() => flash(copyState, 'Copy failed'));
    },
    'btn btn-sm',
  );

  card.body.append(
    checks,
    el('p', {
      class: 'field-hint',
      text: 'You can also type bl followed by a shortcut in the address bar — that path always works, whatever is checked above.',
    }),
    el('div', {
      class: 'code-block',
      children: [el('code', { text: searchUrl }), copyButton, copyState],
    }),
    el('p', {
      class: 'field-hint',
      text: 'Optional alternative: add that URL as a custom search engine at chrome://settings/searchEngines and give it a keyword. Interception above already covers the common case.',
    }),
    checkbox('Confirm before opening a shortcut', stored.settings.dispatchToast, (on) => {
      void commitSettings({ ...stored.settings, dispatchToast: on }, card.saved);
    }),
    el('p', {
      class: 'field-hint',
      text: 'Shows which shortcut fired, with a link to search for what you typed instead — but it holds the page for about 1.2 seconds every time, so it is off by default. Turn it on while you are learning the keywords.',
    }),
  );
  return card.section;
}

/**
 * The exemption list. Empty by default, and the copy has to say why: a user who
 * reads "excluded because they are common words" will look for the list that
 * protects them and find nothing.
 */
function renderStopList(): HTMLElement {
  const card = panelCard(
    'Address-bar interception',
    'Every keyword you own is intercepted in the address bar — if the first word of what you type is a shortcut, it runs, always. To search for those words instead, start the query with \\ or = (“=map of france”). Add a keyword here to exempt it permanently: an exempted keyword is skipped in the address bar but still works from bl + Tab and the toolbar popup.',
  );

  const chips = el('div', { class: 'chip-row' });
  const addInput = textInput('', 'new', true);
  const addField = errorField(
    'Exempt a keyword',
    addInput,
    'err-stop',
    'Lowercase, no spaces. The shortcut keeps working through bl and the popup.',
  );

  suppressedHost = el('p', {
    class: 'field-hint',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });

  const commitList = (next: string[]): void => {
    const unique = [...new Set(next.map((key) => key.trim().toLowerCase()).filter(Boolean))].sort();
    void commitSettings({ ...stored.settings, interceptStopList: unique }, card.saved).then(
      paintChips,
    );
  };

  function paintChips(): void {
    chips.textContent = '';
    const list = [...stopSet()].sort();
    if (list.length === 0) {
      chips.append(
        el('p', {
          class: 'field-hint',
          text: 'Nothing is exempt — every keyword is intercepted in the address bar.',
        }),
      );
      return;
    }
    for (const key of list) {
      const remove = button('×', () => commitList(list.filter((item) => item !== key)), 'chip-x');
      remove.setAttribute('aria-label', `Intercept ${key} again`);
      remove.title = `Stop exempting “${key}”`;
      chips.append(el('span', { class: 'chip chip-removable', children: [key, remove] }));
    }
  }

  const add = (): void => {
    const key = addInput.value.trim().toLowerCase();
    if (!key) return;
    if (/\s/.test(key)) {
      addField.setProblems([
        { level: 'error', text: 'One keyword at a time — a keyword cannot contain a space.' },
      ]);
      return;
    }
    if (stopSet().has(key)) {
      addField.setProblems([{ level: 'error', text: `“${key}” is already exempt.` }]);
      return;
    }
    addInput.value = '';
    addField.setProblems(
      buildKeyOwner().has(key)
        ? []
        : [{ level: 'warn', text: `No shortcut uses “${key}” right now, so nothing changes yet.` }],
    );
    commitList([...stopSet(), key]);
  };

  addInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  });

  paintChips();

  card.body.append(
    chips,
    el('div', {
      class: 'stop-add',
      children: [
        addField.node,
        el('div', {
          class: 'btn-row',
          children: [
            button('Add', add, 'btn'),
            button('Intercept everything', () => commitList([]), 'btn'),
          ],
        }),
      ],
    }),
    suppressedHost,
  );
  return card.section;
}

function paintSuppressed(): void {
  const host = suppressedHost;
  if (!host) return;
  if (!status) {
    host.textContent = 'Checking rules…';
    return;
  }
  const count = statusCount(status, 'suppressed');
  const keywords = statusCount(status, 'keywords');
  host.textContent = `${keywords} ${keywords === 1 ? 'keyword is' : 'keywords are'} intercepted in the address bar; ${count} ${count === 1 ? 'is' : 'are'} exempted by this list.`;
}

function renderAiTemplates(): HTMLElement {
  const card = panelCard(
    'AI prompt templates',
    'These prefill parameters are undocumented and providers change them. If one stops carrying your prompt, fix it here — no rebuild, no waiting.',
  );

  const list = el('div', { class: 'templates' });
  for (const provider of AI_PROVIDERS) {
    const input = textInput(stored.settings.aiTemplates[provider.id] ?? '', provider.template, true);
    const warning = el('p', { class: 'msg msg-warn' });
    warning.hidden = true;

    const check = (): void => {
      const value = input.value.trim();
      warning.hidden = !value || value.includes('{q}');
      warning.textContent = 'Without {q} this template is ignored and the built-in one is used.';
    };
    input.addEventListener('input', check);
    input.addEventListener('change', () => {
      const value = input.value.trim();
      const aiTemplates = { ...stored.settings.aiTemplates };
      if (value) aiTemplates[provider.id] = value;
      else delete aiTemplates[provider.id];
      void commitSettings({ ...stored.settings, aiTemplates }, card.saved);
    });
    check();

    list.append(
      el('div', {
        class: 'field',
        children: [field(provider.label, input, `Default: ${provider.template}`), warning],
      }),
    );
  }

  card.body.append(list);
  return card.section;
}

function renderData(): HTMLElement {
  const card = panelCard(
    'Data',
    'The export holds your shortcuts, your renames and your settings — not the built-in list, so an old file still works after an update.',
  );

  const error = el('p', { class: 'msg msg-error', attrs: { role: 'alert' } });
  error.hidden = true;

  // `hidden` rather than `.visually-hidden`: a 1x1px input is still a focus
  // stop, and this one exists only to be `click()`ed.
  const fileInput = el('input', {
    attrs: {
      type: 'file',
      accept: 'application/json,.json',
      tabindex: '-1',
      'aria-hidden': 'true',
    },
  });
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => void handleImport());

  const choice = el('div', {
    class: 'import-choice',
    attrs: { role: 'group', 'aria-label': 'Confirm import' },
  });
  choice.hidden = true;

  const closeChoice = (): void => {
    choice.textContent = '';
    choice.hidden = true;
  };

  async function handleImport(): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file) return;
    error.hidden = true;
    closeChoice();
    try {
      // Parse before anything is touched: the confirmation is only honest if it
      // can name what the file actually contains.
      askImport(file.name, importJson(await file.text()));
    } catch (err) {
      error.textContent = errorText(err);
      error.hidden = false;
    } finally {
      fileInput.value = '';
    }
  }

  function askImport(fileName: string, imported: ImportedState): void {
    const mine = stored.overrides.custom.length;
    const theirs = imported.overrides.custom.length;
    const plan = mergeOverrides(stored.overrides, imported.overrides);

    const lines: string[] = [
      `${fileName} holds ${countShortcuts(theirs)}. You have ${countShortcuts(mine)}.`,
      `Merge keeps yours and adds ${countShortcuts(plan.added.length)}, leaving your settings alone.`,
      imported.settings
        ? `Replace deletes your ${countShortcuts(mine)} and your settings, leaving only what is in ${fileName}.`
        : `Replace deletes your ${countShortcuts(mine)}, leaving only what is in ${fileName}. That file carries no settings, so yours stay as they are.`,
    ];
    if (plan.renames.length > 0) {
      const renamed = plan.renames.map((rename) => `${rename.from} → ${rename.to}`).join(', ');
      lines.push(`Merge renames the keywords you already use: ${renamed}.`);
    }
    if (plan.duplicates.length > 0) {
      lines.push(`Already identical to yours, so merge skips them: ${plan.duplicates.join(', ')}.`);
    }
    const also: string[] = [];
    if (plan.disables.length > 0) {
      const n = plan.disables.length;
      also.push(
        `turns off ${n} built-in ${n === 1 ? 'shortcut' : 'shortcuts'} (${nameList(plan.disables)})`,
      );
    }
    if (plan.rebinds.length > 0) {
      const n = plan.rebinds.length;
      also.push(
        `rebinds ${n} built-in ${n === 1 ? 'keyword' : 'keywords'} (${nameList(plan.rebinds)})`,
      );
    }
    if (also.length > 0) lines.push(`Merge also ${also.join(' and ')}.`);
    lines.push('Either way, your current setup is exported to your downloads folder first.');

    const done = (text: string): void => {
      notice = { tone: 'ok', text };
      go('#help');
    };
    const fail = (err: unknown): void => {
      closeChoice();
      error.textContent = errorText(err);
      error.hidden = false;
    };

    const merge = (): void => {
      backupState();
      commitState({ overrides: plan.overrides, settings: stored.settings }).then(
        () =>
          done(
            plan.added.length === 0
              ? `Nothing new in ${fileName} — your shortcuts already cover it.`
              : `Merged ${countShortcuts(plan.added.length)} from ${fileName}.`,
          ),
        fail,
      );
    };
    const replace = (): void => {
      backupState();
      commitState(applyImport(imported, stored)).then(
        () => done(`Replaced everything with ${countShortcuts(theirs)} from ${fileName}.`),
        fail,
      );
    };

    choice.textContent = '';
    choice.append(
      el('h3', { class: 'import-title', text: `Import ${fileName}?` }),
      ...lines.map((text) => el('p', { class: 'import-line', text })),
      el('div', {
        class: 'btn-row',
        children: [
          button('Merge', merge, 'btn btn-primary'),
          button('Replace everything', replace, 'btn btn-danger'),
          button('Cancel', closeChoice, 'btn btn-ghost'),
        ],
      }),
    );
    choice.hidden = false;
    choice.querySelector('button')?.focus();
  }

  card.body.append(
    el('div', {
      class: 'btn-row',
      children: [
        button('Export JSON', () => exportState(), 'btn'),
        button('Import JSON…', () => fileInput.click(), 'btn'),
        fileInput,
      ],
    }),
    choice,
    error,
    el('div', {
      class: 'danger-zone',
      children: [
        el('p', {
          text: 'Reset deletes every shortcut you made, restores the built-ins you turned off and puts settings back to their defaults.',
        }),
        confirmButton('Reset to defaults', 'Click again to reset', 'btn btn-danger', () => {
          const defaults = { overrides: clone(DEFAULT_OVERRIDES), settings: clone(DEFAULT_SETTINGS) };
          commitState(defaults).then(
            () => {
              notice = { tone: 'ok', text: 'Everything is back to defaults.' };
              go('#help');
            },
            (err: unknown) => {
              error.textContent = errorText(err);
              error.hidden = false;
            },
          );
        }),
      ],
    }),
  );
  return card.section;
}

function exportState(name = 'bunnylol-shortcuts.json'): void {
  const blob = new Blob([exportJson(stored)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { class: 'visually-hidden' });
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can race the download in Chromium.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Written before any import overwrites anything, so "undo" is a file. */
function backupState(): void {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  exportState(`bunnylol-backup-${stamp}.json`);
}

function countShortcuts(n: number): string {
  return `${n} ${n === 1 ? 'shortcut' : 'shortcuts'}`;
}

/** A list long enough to be trustworthy without being the whole catalogue. */
function nameList(items: string[], limit = 6): string {
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')}, +${items.length - limit} more`;
}

interface MergePlan {
  overrides: Overrides;
  added: Command[];
  renames: { from: string; to: string }[];
  duplicates: string[];
  /** Built-ins the file turns off that are still on here. */
  disables: string[];
  /** Built-ins the file rebinds that carry no rebinding of yours. */
  rebinds: string[];
}

/**
 * Adds an import's shortcuts to the ones already here. Neither side is ever
 * dropped: an incoming alias that is already taken is renamed (`gh` -> `gh2`)
 * and reported, and an incoming shortcut identical to one of ours is skipped
 * rather than duplicated.
 */
function mergeOverrides(current: Overrides, incoming: Overrides): MergePlan {
  const taken = new Set<string>();
  const mine = new Map<string, Command>();
  for (const cmd of current.custom) {
    for (const key of cmd.keys) {
      taken.add(key);
      if (!mine.has(key)) mine.set(key, cmd);
    }
  }

  const added: Command[] = [];
  const renames: { from: string; to: string }[] = [];
  const duplicates: string[] = [];
  // What the two non-`custom` halves of the merge below actually change, so the
  // confirmation can name it instead of promising nothing else moves.
  const disabled = new Set(current.disabled);
  const disables = incoming.disabled.filter((key) => !disabled.has(key));
  const rebinds = Object.keys(incoming.keyOverrides).filter(
    (key) => !(key in current.keyOverrides),
  );

  for (const cmd of incoming.custom) {
    const twin = mine.get(firstKey(cmd));
    if (twin && signatureOf(twin) === signatureOf(cmd)) {
      duplicates.push(firstKey(cmd));
      continue;
    }
    const keys = cmd.keys.map((key) => {
      if (!taken.has(key)) {
        taken.add(key);
        return key;
      }
      let suffix = 2;
      while (taken.has(`${key}${suffix}`)) suffix += 1;
      const renamed = `${key}${suffix}`;
      taken.add(renamed);
      renames.push({ from: key, to: renamed });
      return renamed;
    });
    added.push({ ...cmd, keys });
  }

  return {
    overrides: {
      // Ours win on every collision; the import only fills the gaps.
      disabled: [...new Set([...current.disabled, ...incoming.disabled])],
      keyOverrides: { ...incoming.keyOverrides, ...current.keyOverrides },
      custom: [...current.custom, ...added],
    },
    added,
    renames,
    duplicates,
    disables,
    rebinds,
  };
}

function signatureOf(cmd: Command): string {
  return `${cmd.url}\u0000${cmd.searchUrl ?? ''}\u0000${cmd.handler ?? ''}`;
}

// ------------------------------------------------------------- persistence ----

async function commitOverrides(next: Overrides): Promise<void> {
  applyState({ ...stored, overrides: next });
  await saveOverrides(next);
  scheduleStatusRefresh();
}

async function commitSettings(next: Settings, saved?: HTMLElement): Promise<void> {
  applyState({ ...stored, settings: next });
  try {
    await saveSettings(next);
  } catch (err) {
    reportFailure(err);
    return;
  }
  if (saved) flash(saved);
  paintStatus();
  scheduleStatusRefresh();
}

async function commitState(next: StoredState): Promise<void> {
  applyState(next);
  await saveState(next);
  scheduleStatusRefresh();
}

// ----------------------------------------------------------------- helpers ----

function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const node = el('button', { class: className, text: label, attrs: { type: 'button' } });
  node.addEventListener('click', onClick);
  return node;
}

/**
 * Two-step destructive action. A modal `confirm()` inside an extension page is
 * a worse interruption than arming the button in place — but arming must not
 * turn a double-click into a single destructive gesture, so the confirming
 * click has to arrive as its own deliberate click, after the label has had time
 * to be read.
 */
const CONFIRM_DELAY_MS = 400;

function confirmButton(
  idle: string,
  armed: string,
  className: string,
  action: () => void,
): HTMLButtonElement {
  let armedAt = 0;
  let timer = 0;
  // A held Enter repeats `click` with `detail === 0`, so the double-click guard
  // never sees it; the confirming activation has to follow a key release.
  let released = false;
  const node = el('button', {
    class: className,
    text: idle,
    attrs: { type: 'button', 'aria-live': 'polite' },
  });

  const disarm = (): void => {
    window.clearTimeout(timer);
    armedAt = 0;
    node.textContent = idle;
    node.classList.remove('btn-armed');
  };

  node.addEventListener('click', (event) => {
    // The second click of a double-click carries detail 2; it is one gesture,
    // not two decisions.
    if (event.detail > 1) return;
    if (armedAt === 0) {
      armedAt = Date.now();
      released = false;
      node.textContent = armed;
      node.classList.add('btn-armed');
      timer = window.setTimeout(disarm, 4000);
      return;
    }
    if (!released) return;
    if (Date.now() - armedAt < CONFIRM_DELAY_MS) return;
    disarm();
    action();
  });
  // Both fire before the `click` they belong to, so a real second gesture is
  // already marked released by the time the handler above runs.
  node.addEventListener('keyup', () => {
    released = true;
  });
  node.addEventListener('pointerup', () => {
    released = true;
  });
  node.addEventListener('blur', disarm);
  return node;
}

function textInput(value: string, placeholder = '', mono = false): HTMLInputElement {
  const input = el('input', {
    class: mono ? 'input mono' : 'input',
    attrs: { type: 'text', placeholder, autocomplete: 'off', spellcheck: 'false' },
  });
  input.value = value;
  return input;
}

function selectControl(
  options: { value: string; label: string }[],
  value: string,
): HTMLSelectElement {
  const node = el('select', { class: 'select' });
  for (const option of options) {
    const item = el('option', { text: option.label });
    item.value = option.value;
    node.append(item);
  }
  node.value = value;
  return node;
}

function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  const input = el('input', { attrs: { type: 'checkbox' } });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'check', children: [input, label] });
}

function switchControl(
  label: string,
  checked: boolean,
  onChange: (on: boolean) => void,
): HTMLElement {
  const input = el('input', { attrs: { type: 'checkbox' } });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', {
    class: 'switch',
    children: [input, el('span', { class: 'visually-hidden', text: label })],
  });
}

function field(label: string, control: HTMLElement, hint?: string, wide = false): HTMLElement {
  if (!control.id) control.id = nextId('field');
  const labelNode = el('label', { class: 'field-label', text: label });
  labelNode.htmlFor = control.id;
  const children: Node[] = [labelNode, control];
  if (hint) {
    const hintNode = el('p', { class: 'field-hint', id: `${control.id}-hint`, text: hint });
    control.setAttribute('aria-describedby', hintNode.id);
    children.push(hintNode);
  }
  return el('div', { class: wide ? 'field field-wide' : 'field', children });
}

interface FieldSlot {
  node: HTMLElement;
  setProblems: (problems: Problem[]) => void;
}

/**
 * A `field()` that owns its own validation messages: the problem text lives
 * inside the field wrapper and is wired to the control with `aria-describedby`,
 * so a screen reader reaching the input hears what is wrong with it rather than
 * finding an unattributed list further down the page.
 */
function errorField(
  label: string,
  control: HTMLInputElement | HTMLSelectElement,
  errorId: string,
  hint?: string,
  wide = false,
): FieldSlot {
  const node = field(label, control, hint, wide);
  const hintId = control.getAttribute('aria-describedby') ?? '';
  const errors = el('div', {
    class: 'field-errors',
    id: errorId,
    attrs: { 'aria-live': 'polite' },
  });
  node.append(errors);

  return {
    node,
    setProblems(problems: Problem[]): void {
      errors.textContent = '';
      for (const problem of problems) {
        errors.append(
          el('p', {
            class: problem.level === 'error' ? 'msg msg-error' : 'msg msg-warn',
            text: problem.text,
          }),
        );
      }
      const failed = problems.some((problem) => problem.level === 'error');
      control.classList.toggle('bad', failed);
      if (failed) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
      const described = [hintId, problems.length > 0 ? errorId : ''].filter(Boolean).join(' ');
      if (described) control.setAttribute('aria-describedby', described);
      else control.removeAttribute('aria-describedby');
    },
  };
}

function panelCard(
  title: string,
  sub?: string,
): { section: HTMLElement; body: HTMLElement; saved: HTMLElement } {
  const saved = el('span', { class: 'saved', attrs: { role: 'status', 'aria-live': 'polite' } });
  const head = el('div', { class: 'panel-head' });
  const text = el('div', { class: 'panel-head-text', children: [el('h2', { class: 'panel-title', text: title })] });
  if (sub) text.append(el('p', { class: 'panel-sub', text: sub }));
  head.append(text, saved);

  const body = el('div', { class: 'panel-body' });
  return { section: el('section', { class: 'panel', children: [head, body] }), body, saved };
}

const flashTimers = new WeakMap<HTMLElement, number>();

function flash(node: HTMLElement, text = 'Saved'): void {
  window.clearTimeout(flashTimers.get(node));
  node.textContent = text;
  node.classList.add('show');
  flashTimers.set(node, window.setTimeout(() => node.classList.remove('show'), 1800));
}

/**
 * The alias a command leads with. Deliberately not `shortcutId`: its callers
 * key maps by what the user types, and a custom shortcut's id is a `u:` slug
 * that answers to nothing in the address bar.
 */
function firstKey(cmd: Command): string {
  return (cmd.keys[0] ?? '').trim().toLowerCase();
}

function reportFailure(err: unknown): void {
  console.error('[bunnylol] could not save', err);
}
