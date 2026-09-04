// @vitest-environment jsdom

/**
 * The "Hidden shortcuts" state machine, driven through the real `renderBrowse`.
 *
 * This is the only suite in the repo that runs in a DOM. Everything else stays
 * on vitest's global `environment: 'node'`, which is load-bearing: `src/lib` and
 * `src/options/model` are required to import cleanly without `document` or
 * `chrome.*`, and a suite that quietly gave them a DOM would stop that rule from
 * failing anything. So the opt-in is the docblock above, per file, and the
 * global default is left alone.
 *
 * What is exercised here is the one thing on the browse page that changes
 * without a re-render: a switch moves a row's NODE between its section and the
 * hidden group, and `applyFilter` then decides every count, every heading and
 * what is on screen. That path has no pure-model test that can see it, because
 * the bug it protects against is two writers of `hidden`, not a wrong number.
 *
 * WHAT jsdom CANNOT CATCH, and what therefore still needs a real browser:
 *
 * - **No layout.** jsdom computes no boxes and honours no stylesheet, so
 *   `focus()` inside a `display: none` subtree SUCCEEDS here. The ordering rule
 *   that `move()` returns the element and the caller focuses it only AFTER
 *   `applyFilter` has decided visibility is exactly the rule jsdom will not
 *   break: a version that focused too early passes every assertion below and
 *   drops focus on `<body>` in Chrome.
 * - **`order` is invisible.** The filter reorders rows by writing
 *   `style.order` on a flex container. jsdom keeps DOM order, so a test can read
 *   the property back but cannot see the list the user sees. Whether the runs
 *   inside the hidden group actually read as runs, and whether a filtered list
 *   is ranked, is a screenshot question.
 * - **`hidden` is checked as a property**, not as something that removed pixels.
 *   A stylesheet rule that overrode `[hidden]` would go unnoticed here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './helpers/at';
import { BUILTIN_COMMANDS } from '../src/lib/commands';
import { shortcutId } from '../src/lib/overrides';
import type { Command } from '../src/lib/types';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS } from '../src/lib/types';
import type { ChromeStub } from './helpers/rules';
import { installChromeStub } from './helpers/rules';

// The store is the real one, so `commitOverrides` still applies the write
// optimistically and still reaches storage: only the counting is added. The
// "exactly one write" rule below is about how many times it is CALLED, and a
// stub that reimplemented it could not answer that about the shipped function.
vi.mock('../src/options/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/options/store')>();
  return { ...actual, commitOverrides: vi.fn(actual.commitOverrides) };
});

const { applyState, commitOverrides, getState, setFilter } = await import('../src/options/store');
const { forgetCollapsed, renderBrowse } = await import('../src/options/views/browse');

/** Every shipped shortcut, deleted. The page then holds only the five custom
 *  commands below, which is what makes "both headings' counts change" a pair of
 *  exact numbers instead of an assertion about the live registry. It is a state
 *  a user can really be in: Delete works on shipped rows too. */
const SHIPPED_IDS = BUILTIN_COMMANDS.map(shortcutId);

function custom(id: string, key: string, name: string, category: string): Command {
  return {
    id,
    keys: [key],
    name,
    description: `The ${name} shortcut.`,
    url: `https://example.com/${key}`,
    category,
    builtin: false,
  };
}

// Two sections, so a switch has somewhere to move a row FROM and the hidden
// group has two runs to tell apart. Three in one of them, so a run can hold two
// while its section still has something live, which is the case whose wording
// differs.
const FIXTURE: Command[] = [
  custom('u:alpha', 'ga', 'Alpha', 'dev'),
  custom('u:bravo', 'gb', 'Bravo', 'dev'),
  custom('u:charlie', 'gc', 'Charlie', 'dev'),
  custom('u:delta', 'sd', 'Delta', 'social'),
  custom('u:echo', 'se', 'Echo', 'social'),
];

let stub: ChromeStub | null = null;

beforeEach(() => {
  stub = installChromeStub();
  document.body.innerHTML = '';
  // Module state that outlives a render: the filter box is seeded from the
  // store, and the fold set is a page-level singleton. Both would carry the
  // previous test's answer into this one.
  setFilter('');
  forgetCollapsed();
  vi.mocked(commitOverrides).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  stub?.restore();
  stub = null;
});

function seed(disabled: string[] = []): void {
  applyState({
    overrides: {
      ...DEFAULT_OVERRIDES,
      edits: {},
      sections: [],
      custom: FIXTURE,
      disabled,
      deleted: SHIPPED_IDS,
    },
    settings: { ...DEFAULT_SETTINGS },
  });
}

/** Renders into a real document: `focus()` and `document.activeElement` need
 *  the nodes to be connected, and so does anything reading a parent chain. */
function render(): void {
  document.body.append(...renderBrowse());
}

function group(title: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.group')].find(
    (node) => node.querySelector('.group-title')?.textContent === title,
  );
  if (!found) throw new Error(`no group titled ${title}`);
  return found;
}

function rowsHost(title: string): HTMLElement {
  const host = group(title).querySelector<HTMLElement>('.rows');
  if (!host) throw new Error(`group ${title} has no rows host`);
  return host;
}

function headingCount(title: string): string {
  return group(title).querySelector('.group-count')?.textContent ?? '';
}

/** By id rather than by name: `.row-name` also carries the badges, including
 *  the hidden "omnibox only" one, so its text is not the shortcut's name. */
function row(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

function switchOf(id: string): HTMLInputElement {
  const input = row(id).querySelector<HTMLInputElement>('.switch input');
  if (!input) throw new Error(`row ${id} has no switch`);
  return input;
}

function toggle(id: string, on: boolean): void {
  const input = switchOf(id);
  input.checked = on;
  input.dispatchEvent(new Event('change'));
}

function toolbarCount(): string {
  return document.querySelector('.count')?.textContent ?? '';
}

/** The run heading inside "Hidden shortcuts" that names a section. */
function run(label: string): HTMLElement {
  const found = [...rowsHost('Hidden shortcuts').querySelectorAll<HTMLElement>('.run-head')].find(
    (node) => node.querySelector('.run-title')?.textContent === label,
  );
  if (!found) throw new Error(`no run for ${label}`);
  return found;
}

function typeFilter(text: string): void {
  const input = document.querySelector<HTMLInputElement>('#filter');
  if (!input) throw new Error('no filter box');
  input.value = text;
  input.dispatchEvent(new Event('input'));
}

/** Lets the optimistic write finish reaching the storage stub. A macrotask,
 *  because `saveOverrides` reads the profile back before it writes. */
async function settle(): Promise<void> {
  await new Promise((done) => {
    setTimeout(done, 0);
  });
}

describe('switching a row off', () => {
  it('moves the node into the hidden group and repaints both headings', () => {
    seed();
    render();

    expect(headingCount('Developer')).toBe('3');
    expect(headingCount('Social')).toBe('2');
    // Nothing is switched off, so the group is built but not on screen.
    expect(group('Hidden shortcuts').hidden).toBe(true);
    expect(toolbarCount()).toBe('5 shortcuts');

    toggle('u:alpha', false);

    expect(row('u:alpha').parentElement).toBe(rowsHost('Hidden shortcuts'));
    expect(headingCount('Developer')).toBe('2');
    expect(headingCount('Hidden shortcuts')).toBe('1');
    expect(headingCount('Social')).toBe('2');
    expect(group('Hidden shortcuts').hidden).toBe(false);
    expect(toolbarCount()).toBe('4 of 5 shortcuts on');
    // The group appears folded: a user who switches something off is not asking
    // to be shown a list of what is off.
    expect(rowsHost('Hidden shortcuts').hidden).toBe(true);
    // A run of one is already one click away through the row's own switch, so
    // its heading is drawn and its bulk action is not.
    expect(run('Developer').hidden).toBe(false);
    expect(run('Developer').querySelector('button')?.hidden).toBe(true);
  });

  it('leaves the section group on the page when its last live row goes', () => {
    seed(['u:delta']);
    render();

    expect(headingCount('Social')).toBe('1');
    toggle('u:echo', false);

    // Empty, so hidden, but still built and still `u:echo`'s home: switching it
    // back on has to return it there without a re-render.
    expect(group('Social').hidden).toBe(true);
    expect(headingCount('Hidden shortcuts')).toBe('2');
    expect(toolbarCount()).toBe('3 of 5 shortcuts on');

    toggle('u:echo', true);
    expect(group('Social').hidden).toBe(false);
    expect(row('u:echo').parentElement).toBe(rowsHost('Social'));
  });
});

describe('switching the last hidden row back on', () => {
  it('takes the hidden group off the page', () => {
    seed(['u:alpha']);
    render();

    expect(group('Hidden shortcuts').hidden).toBe(false);
    expect(headingCount('Hidden shortcuts')).toBe('1');

    toggle('u:alpha', true);

    expect(group('Hidden shortcuts').hidden).toBe(true);
    expect(headingCount('Hidden shortcuts')).toBe('0');
    expect(headingCount('Developer')).toBe('3');
    expect(row('u:alpha').parentElement).toBe(rowsHost('Developer'));
    expect(toolbarCount()).toBe('5 shortcuts');
  });
});

describe('a run bulk action', () => {
  it('switches the whole run on with exactly ONE commitOverrides call', async () => {
    seed(['u:alpha', 'u:bravo']);
    render();

    const action = run('Developer').querySelector('button');
    if (!action) throw new Error('the run offers no action');
    // Two of Developer are off and one is still live, so the action says which
    // of the two things it is doing.
    expect(action.hidden).toBe(false);
    expect(action.textContent).toBe('Turn on the rest of Developer');
    // One run drawn, so the whole-group action would repeat it and is not shown.
    expect(document.querySelector<HTMLElement>('.group-actions')?.hidden).toBe(true);

    action.click();

    // The whole point: a burst of per-row writes is the pattern invariant 15
    // exists to survive, so the run is ONE write for two rows.
    expect(vi.mocked(commitOverrides)).toHaveBeenCalledTimes(1);
    expect(at(vi.mocked(commitOverrides).mock.calls, 0)[0].disabled).toEqual([]);
    expect(getState().overrides.disabled).toEqual([]);

    // And the page moved in the same tick as the click, without waiting on it.
    expect(row('u:alpha').parentElement).toBe(rowsHost('Developer'));
    expect(row('u:bravo').parentElement).toBe(rowsHost('Developer'));
    expect(headingCount('Developer')).toBe('3');
    expect(group('Hidden shortcuts').hidden).toBe(true);
    expect(switchOf('u:alpha').checked).toBe(true);
    expect(row('u:alpha').classList.contains('off')).toBe(false);

    await settle();
    // One call, and one round trip to `chrome.storage.local` behind it.
    expect(stub?.writes).toBe(1);
  });

  it('offers no action for a run of one', () => {
    seed(['u:alpha', 'u:delta']);
    render();

    expect(run('Developer').querySelector('button')?.hidden).toBe(true);
    expect(run('Social').querySelector('button')?.hidden).toBe(true);
    // Two runs drawn, so the whole-group action is the one that says more.
    const all = document.querySelector<HTMLElement>('.group-actions');
    expect(all?.hidden).toBe(false);
    expect(all?.textContent).toBe('Turn them all on');
  });
});

describe('deleting a row', () => {
  it('drops it from every total, including the hidden group it was in', () => {
    seed(['u:charlie']);
    render();

    expect(toolbarCount()).toBe('4 of 5 shortcuts on');
    expect(headingCount('Hidden shortcuts')).toBe('1');

    remove('u:charlie');

    // The row's node is gone from the document, and the counts skip it even
    // though its `RowRef` is still filed in the hidden group's list.
    expect(document.querySelector('.row[data-id="u:charlie"]')).toBeNull();
    expect(toolbarCount()).toBe('4 shortcuts');
    expect(headingCount('Hidden shortcuts')).toBe('0');
    expect(group('Hidden shortcuts').hidden).toBe(true);
    expect(headingCount('Developer')).toBe('2');

    // And it stays skipped once the filter recounts from scratch.
    typeFilter('the');
    expect(toolbarCount()).toBe('4 of 4 shortcuts');
  });
});

describe('the filter', () => {
  it('reveals a hidden row by force-expanding the folded hidden group', () => {
    seed(['u:alpha']);
    render();

    // Folded by default, so the row is on the page but not on screen.
    expect(rowsHost('Hidden shortcuts').hidden).toBe(true);
    expect(row('u:alpha').parentElement).toBe(rowsHost('Hidden shortcuts'));

    typeFilter('alpha');

    expect(group('Hidden shortcuts').hidden).toBe(false);
    expect(rowsHost('Hidden shortcuts').hidden).toBe(false);
    expect(row('u:alpha').hidden).toBe(false);
    expect(group('Developer').hidden).toBe(true);
    expect(toolbarCount()).toBe('1 of 5 shortcuts, 0 on');
    // The fold is not writable while a query is live, and the heading says so
    // rather than dropping out of the tab order.
    const toggleButton = group('Hidden shortcuts').querySelector('.group-toggle');
    expect(toggleButton?.getAttribute('aria-expanded')).toBe('true');
    expect(toggleButton?.getAttribute('aria-disabled')).toBe('true');
    // The runs and the bulk actions go quiet: the filter's answer is one ranked
    // list, so a heading naming a run would be naming one the ranking broke up.
    expect(run('Developer').hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.toolbar-actions')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.group-actions')?.hidden).toBe(true);

    // Clearing it folds the group back up, rather than leaving it open.
    typeFilter('');
    expect(rowsHost('Hidden shortcuts').hidden).toBe(true);
    expect(group('Hidden shortcuts').hidden).toBe(false);
  });
});

/**
 * Delete is a two-step arm-then-confirm, and the confirming click has to be its
 * own deliberate gesture: a second click carrying `detail > 1` is refused, and
 * so is one that arrives before the label has had time to be read or without a
 * key or pointer release in between. Fake timers move the clock past that
 * window without making the suite wait for it.
 */
function remove(id: string): void {
  const button = row(id).querySelector<HTMLButtonElement>('.row-actions [title^="Delete"]');
  if (!button) throw new Error(`row ${id} has no delete button`);
  vi.useFakeTimers();
  button.dispatchEvent(new MouseEvent('click'));
  button.dispatchEvent(new Event('pointerup'));
  vi.advanceTimersByTime(500);
  button.dispatchEvent(new MouseEvent('click'));
  vi.useRealTimers();
}
