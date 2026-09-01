/**
 * The rule-status pill's state, as a pure function of the last sync result.
 *
 * It lives outside `options.ts` because that module touches `document` at import
 * time, so the three-way mapping — failed, partial, healthy — is only testable
 * once it is separated from the node that renders it.
 */

import type { RuleStatus } from '../lib/types';

export type PillTone = 'busy' | 'ok' | 'warn' | 'bad';

export interface PillView {
  tone: PillTone;
  text: string;
  /** Secondary line, rendered muted next to the text. Empty when there is none. */
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
 */
export function pillView({ status, busy, engineCount }: PillInput): PillView {
  if (busy) return { tone: 'busy', text: 'Syncing rules…', detail: '' };
  if (!status) return { tone: 'busy', text: 'Checking rules…', detail: '' };

  const error = messageOf(status, 'error');
  if (error) return { tone: 'bad', text: 'Rules not registered', detail: error };

  if (statusCount(status, 'registered') > 0) {
    const dropped = statusCount(status, 'dropped');
    const suppressed = statusCount(status, 'suppressed');
    const warning = messageOf(status, 'warning');
    const notes: string[] = [];
    // An exemption is the user's own choice, so it is reported without turning
    // the pill amber; a dropped keyword is something they asked for that is not
    // happening.
    if (suppressed > 0) notes.push(`${suppressed} exempted by you`);
    if (warning) notes.push(warning);
    else if (dropped > 0) notes.push(`${dropped} Chrome would not accept`);

    return {
      tone: warning || dropped > 0 ? 'warn' : 'ok',
      text: `Intercepting ${statusCount(status, 'keywords')} keywords`,
      detail: notes.join(' · '),
    };
  }

  if (engineCount === 0) return { tone: 'warn', text: 'Interception off', detail: '' };
  return { tone: 'bad', text: 'Rules not registered', detail: '' };
}

export const PILL_CLASS: Record<PillTone, string> = {
  busy: 'pill',
  ok: 'pill pill-ok',
  warn: 'pill pill-warn',
  bad: 'pill pill-bad',
};

/**
 * Fields are read defensively because the options page outlives a worker update
 * — Chrome keeps this tab open across a reload of the extension — so a reply in
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
