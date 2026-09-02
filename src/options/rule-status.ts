/**
 * The rule-status pill in the topbar, and the "exempted by this list" line in
 * Settings, both painted from the same last-known `RuleStatus`, which is this
 * module's own state. Nothing else on the page needs to know a sync happened;
 * `store.ts` calls back into `scheduleStatusRefresh` through the `afterCommit`
 * hook rather than this module reaching into the store to schedule itself.
 */

import { errorText } from '../lib/text';
import type { BgMessage, RuleStatus } from '../lib/types';
import { el } from '../ui/dom';
import { getState } from './store';
import { PILL_CLASS, pillView, statusCount } from './status';

let status: RuleStatus | null = null;
let statusBusy = false;
let statusHost: HTMLElement | null = null;
let suppressedHost: HTMLElement | null = null;
let resyncButton: HTMLButtonElement | null = null;
let statusTimer = 0;

export function setStatusHost(host: HTMLElement | null): void {
  statusHost = host;
}

export function setResyncButton(node: HTMLButtonElement | null): void {
  resyncButton = node;
}

export function setSuppressedHost(node: HTMLElement | null): void {
  suppressedHost = node;
}

export function getStatus(): RuleStatus | null {
  return status;
}

/** Live-region hosts belong to the nodes about to be thrown away; whoever
 *  renders next re-claims them. Called at the top of `render()`. */
export function resetHosts(): void {
  suppressedHost = null;
}

export function paintStatus(): void {
  paintSuppressed();
  const host = statusHost;
  if (!host) return;
  const view = pillView({
    status,
    busy: statusBusy,
    engineCount: getState().settings.interceptEngines.length,
  });

  host.textContent = '';
  host.className = PILL_CLASS[view.tone];
  // The detail is nested inside the message rather than beside it, so it takes
  // its own line under the text and truncates there instead of competing with
  // it for the one the dot is on. `.status > span { min-width: 0 }` is what
  // lets that line shrink far enough to ellipsise.
  const message = el('span', { text: view.text });
  if (view.detail) {
    message.append(el('span', { class: 'status-detail', text: view.detail, title: view.detail }));
  }
  host.append(el('span', { class: 'status-dot' }), message);

  if (resyncButton) resyncButton.disabled = statusBusy;
}

export async function refreshStatus(): Promise<void> {
  status = await readStatus({ type: 'getRuleStatus' });
  paintStatus();
}

export async function resync(): Promise<void> {
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
export function runtimeId(): string {
  return typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : '';
}

export function scheduleStatusRefresh(): void {
  // The worker re-syncs on the storage change we just wrote; give it a beat so
  // the status reports the new rule count rather than the old one.
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => void refreshStatus(), 500);
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
