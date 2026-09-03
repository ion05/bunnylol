/**
 * The rule-status pill is the only place the user learns that a keyword they
 * asked for is not actually being intercepted, so the states have to stay
 * distinct: red means nothing is intercepted, amber means most of it is, and
 * `null` means there is nothing to report and the topbar shows nothing.
 * Reading `error` for partial coverage collapsed amber into red and hid the
 * difference: these tests pin the split.
 */

import { describe, expect, it } from 'vitest';
import { PILL_CLASS, pillView } from '../src/options/status';
import type { RuleStatus } from '../src/lib/types';

function status(patch: Partial<RuleStatus> = {}): RuleStatus {
  return {
    registered: 60,
    keywords: 317,
    suppressed: 0,
    dropped: 0,
    error: null,
    warning: null,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    ...patch,
  };
}

const HEALTHY = { status: status(), busy: false, engineCount: 3 };

describe('pillView', () => {
  it('says nothing about a healthy sync', () => {
    expect(pillView(HEALTHY)).toBeNull();
  });

  it('stays silent when the only shortfall is the user’s own exemptions', () => {
    // An exemption is the user's own choice, and the Settings list that made it
    // counts them under itself. Nothing here is for the topbar to raise.
    expect(pillView({ ...HEALTHY, status: status({ keywords: 315, suppressed: 2 }) })).toBeNull();
  });

  it('turns amber, not red, when coverage is partial', () => {
    const view = pillView({
      ...HEALTHY,
      status: status({
        keywords: 314,
        dropped: 3,
        warning: '3 keyword(s) are not intercepted: the rule budget is full.',
      }),
    });
    expect(view?.tone).toBe('warn');
    expect(view?.text).toBe('Some keywords not intercepted');
    expect(view?.detail).toBe('3 keyword(s) are not intercepted: the rule budget is full.');
  });

  it('carries both an exemption count and the warning', () => {
    const view = pillView({
      ...HEALTHY,
      status: status({ keywords: 310, suppressed: 4, dropped: 3, warning: 'Chrome rejected 3.' }),
    });
    expect(view?.detail).toBe('4 exempted by you · Chrome rejected 3.');
  });

  it('falls back to a dropped count when the background reported no warning text', () => {
    const view = pillView({ ...HEALTHY, status: status({ keywords: 314, dropped: 3 }) });
    expect(view?.tone).toBe('warn');
    expect(view?.detail).toBe('3 Chrome would not accept');
  });

  it('goes red only when the sync itself failed', () => {
    const view = pillView({
      ...HEALTHY,
      status: status({ registered: 0, keywords: 0, dropped: 317, error: 'Rule limit exceeded.' }),
    });
    expect(view).toEqual({
      tone: 'bad',
      text: 'Rules not registered',
      detail: 'Rule limit exceeded.',
    });
  });

  it('prefers the error even when rules survive from an earlier sync', () => {
    const view = pillView({
      ...HEALTHY,
      status: status({ registered: 60, keywords: 0, error: 'The worker did not respond.' }),
    });
    expect(view?.tone).toBe('bad');
  });

  it('distinguishes interception turned off from interception broken', () => {
    const empty = status({ registered: 0, keywords: 0 });
    expect(pillView({ status: empty, busy: false, engineCount: 0 })).toEqual({
      tone: 'warn',
      text: 'Interception off',
      detail: '',
    });
    expect(pillView({ status: empty, busy: false, engineCount: 3 })).toEqual({
      tone: 'bad',
      text: 'Rules not registered',
      detail: '',
    });
  });

  it('shows a busy state for a re-sync the user asked for, and none for the first reply', () => {
    // Re-sync is a button press, so it gets an answer. The wait for the first
    // reply is not, and a word that appears and vanishes on every render is
    // noise on a page that is about to say nothing at all.
    expect(pillView({ ...HEALTHY, busy: true })?.text).toBe('Syncing rules…');
    expect(pillView({ status: null, busy: false, engineCount: 3 })).toBeNull();
  });

  // The options tab survives a reload of the extension, so it can be handed a
  // status from the worker it was loaded with rather than the one running now.
  it('renders an older-shaped status without a warning field', () => {
    const legacy = { ...status({ keywords: 314, dropped: 3 }) } as Partial<RuleStatus>;
    delete legacy.warning;
    const view = pillView({
      ...HEALTHY,
      status: legacy as RuleStatus,
    });
    expect(view?.tone).toBe('warn');
    expect(view?.detail).toBe('3 Chrome would not accept');
  });

  it('never prints undefined when counts are missing', () => {
    // Missing counts read as zero, so this is a healthy sync and says nothing,
    // rather than a pill built out of undefined.
    const legacy = { registered: 60, error: null, extensionId: '' } as unknown as RuleStatus;
    expect(pillView({ status: legacy, busy: false, engineCount: 3 })).toBeNull();
  });

  it('maps every tone to a status class', () => {
    // No 'ok': a healthy sync is `null`, so nothing can ask for the green tone.
    expect(Object.keys(PILL_CLASS).sort()).toEqual(['bad', 'busy', 'warn']);
    // The capsule is gone: every tone is the `.status` component, and only the
    // two that have something to report add a modifier.
    expect(PILL_CLASS.busy).toBe('status');
    expect(PILL_CLASS.warn).toBe('status status-warn');
    expect(PILL_CLASS.bad).toBe('status status-bad');
  });
});
