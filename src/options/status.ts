/**
 * The rule-status pill's state, as a pure function of the last sync result.
 *
 * It lives outside `options.ts` because that module touches `document` at import
 * time, so the three-way mapping of failed, partial and healthy is only
 * testable once it is separated from the node that renders it.
 */

import type { RuleStatus } from '../lib/types';

/**
 * No 'ok'. A healthy sync answers `null` and the topbar renders nothing, so
 * the green tone had no input that could reach it: every path out of
 * `pillView` below is busy, warn, bad or null.
 */
export type PillTone = 'busy' | 'warn' | 'bad';

export interface PillView {
  tone: PillTone;
  text: string;
  /** Secondary line, rendered under the text and truncated there. Empty when
   *  there is none. */
  detail: string;
}

export interface PillInput {
  /** The last reply from the background, or null before the first one lands. */
  status: RuleStatus | null;
  busy: boolean;
  /** Engines selected for interception; none means the user turned it off. */
  engineCount: number;
}

/**
 * `error` and `warning` are read in that order and mean different things: a
 * sync that failed intercepts nothing, while partial coverage still intercepts
 * everything Chrome accepted. Collapsing them paints the red state over a
 * working setup that merely dropped a keyword.
 *
 * `null` means there is nothing to say, and the topbar shows nothing at all.
 * Working software does not need a label announcing that it is working, and
 * that label was on screen on every page, for everybody, permanently. The pill
 * exists for the states somebody has to act on, so a healthy sync is silent,
 * and so is the wait for the first reply, which would otherwise be a word that
 * flashes up and vanishes on every render.
 */
export function pillView({ status, busy, engineCount }: PillInput): PillView | null {
  // The one busy state kept: it answers a button the user just pressed.
  if (busy) return { tone: 'busy', text: 'Syncing rules…', detail: '' };
  if (!status) return null;

  const error = messageOf(status, 'error');
  if (error) return { tone: 'bad', text: 'Rules not registered', detail: error };

  if (statusCount(status, 'registered') > 0) {
    const dropped = statusCount(status, 'dropped');
    const suppressed = statusCount(status, 'suppressed');
    const warning = messageOf(status, 'warning');
    const notes: string[] = [];
    // An exemption is the user's own choice, so it is reported without turning
    // the status amber; a dropped keyword is something they asked for that is not
    // happening.
    if (suppressed > 0) notes.push(`${suppressed} exempted by you`);
    if (warning) notes.push(warning);
    else if (dropped > 0) notes.push(`${dropped} Chrome would not accept`);

    // No keyword count in the headline: the number is not something anybody
    // acts on, and it moved every time a shortcut was toggled. The counts that
    // matter, what was exempted, what Chrome refused, stay in the detail.
    const partial = Boolean(warning) || dropped > 0;
    // Healthy is silent, exemptions and all: an exemption is the user's own
    // choice, and Settings already counts them under the list that made them.
    if (!partial) return null;
    return { tone: 'warn', text: 'Some keywords not intercepted', detail: notes.join(' · ') };
  }

  if (engineCount === 0) return { tone: 'warn', text: 'Interception off', detail: '' };
  return { tone: 'bad', text: 'Rules not registered', detail: '' };
}

/** The one tone -> appearance seam. The capsule is gone: what the page renders
 *  is the `.status` component from design/components.css: a 6px dot and a line
 *  of text, with the neutral tone carrying no modifier at all. */
export const PILL_CLASS: Record<PillTone, string> = {
  busy: 'status',
  warn: 'status status-warn',
  bad: 'status status-bad',
};

/**
 * Fields are read defensively because the options page outlives a worker update,
 * Chrome keeps this tab open across a reload of the extension, so a reply in
 * an older shape, one with no `warning` at all, has to render as "nothing to
 * report" rather than as "undefined keywords".
 */
export function statusCount(
  status: RuleStatus,
  field: 'registered' | 'keywords' | 'dropped' | 'suppressed',
): number {
  const count: unknown = status[field];
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
}

function messageOf(status: RuleStatus, field: 'error' | 'warning'): string {
  const text: unknown = status[field];
  return typeof text === 'string' ? text.trim() : '';
}
