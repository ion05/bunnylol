/**
 * The options page's module-level state, behind accessor and mutator
 * functions so a view can never hold a stale copy of it: every read goes
 * through a getter, so a commit made by one view is visible to the next
 * render no matter which view issued it.
 *
 * Persistence lives here too: `commitOverrides`/`commitSettings`/`commitState`
 * are the only three ways anything on this page writes to storage, and each
 * one applies the write optimistically before it is confirmed.
 */

import { BUILTIN_COMMANDS } from '../lib/commands';
import { mergeCommands } from '../lib/resolve';
import { saveOverrides, saveSettings, saveState } from '../lib/storage';
import { clone } from '../lib/text';
import type { Command, Overrides, Settings, StoredState } from '../lib/types';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS } from '../lib/types';
import { flash } from './dom';
import type { Route, RouteName } from './router';

export interface Notice {
  tone: 'ok' | 'error';
  text: string;
}

let stored: StoredState = { overrides: clone(DEFAULT_OVERRIDES), settings: clone(DEFAULT_SETTINGS) };
let commands: Command[] = mergeCommands(BUILTIN_COMMANDS, stored.overrides);
let route: Route = { name: 'help', params: new URLSearchParams() };
let lastRoute: RouteName | null = null;
let notice: Notice | null = null;
let browseFilter = '';
let sampleArgs = 'example query';

export function getState(): StoredState {
  return stored;
}

export function getCommands(): Command[] {
  return commands;
}

export function applyState(next: StoredState): void {
  stored = next;
  commands = mergeCommands(BUILTIN_COMMANDS, next.overrides);
}

export function getRoute(): Route {
  return route;
}

export function setRoute(next: Route): void {
  route = next;
}

export function getLastRoute(): RouteName | null {
  return lastRoute;
}

export function setLastRoute(name: RouteName | null): void {
  lastRoute = name;
}

export function takeNotice(): Notice | null {
  const current = notice;
  notice = null;
  return current;
}

export function setNotice(n: Notice): void {
  notice = n;
}

export function getFilter(): string {
  return browseFilter;
}

export function setFilter(v: string): void {
  browseFilter = v;
}

export function getSampleArgs(): string {
  return sampleArgs;
}

export function setSampleArgs(v: string): void {
  sampleArgs = v;
}

/** The aliases exempted through `interceptStopList`, lowercased. */
export function stopSet(): Set<string> {
  return new Set((stored.settings.interceptStopList ?? []).map((key) => key.trim().toLowerCase()));
}

export function reportFailure(err: unknown): void {
  console.error('[bunnylol] could not save', err);
}

// ------------------------------------------------------------- persistence ----

// A commit's caller does not know, and should not have to know, what needs to
// refresh afterwards: that would make every commit site responsible for
// wiring the rule status. `setAfterCommit` lets `boot()` supply that hook
// once, breaking what would otherwise be a store -> rule-status -> store
// import cycle.
let afterCommit: (() => void) | null = null;

export function setAfterCommit(fn: () => void): void {
  afterCommit = fn;
}

// `commitSettings` alone also repaints the rule status synchronously (a
// settings change, e.g. which engines are intercepted, can change what the
// status should say before the async re-sync below even starts). That paint is
// owned by rule-status.ts too, so it is threaded through the same way.
let paintStatusHook: (() => void) | null = null;

export function setStatusPainter(fn: () => void): void {
  paintStatusHook = fn;
}

export async function commitOverrides(next: Overrides): Promise<void> {
  applyState({ ...stored, overrides: next });
  await saveOverrides(next);
  afterCommit?.();
}

export async function commitSettings(next: Settings, saved?: HTMLElement): Promise<void> {
  applyState({ ...stored, settings: next });
  try {
    await saveSettings(next);
  } catch (err) {
    reportFailure(err);
    return;
  }
  if (saved) flash(saved);
  paintStatusHook?.();
  afterCommit?.();
}

export async function commitState(next: StoredState): Promise<void> {
  applyState(next);
  await saveState(next);
  afterCommit?.();
}
