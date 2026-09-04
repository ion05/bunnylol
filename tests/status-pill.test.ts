/**
 * The rule-status pill is the only place the user learns that a keyword they
 * asked for is not actually being intercepted, so the states have to stay
 * distinct: red means nothing is intercepted, amber means most of it is, and
 * `null` means there is nothing to report and the topbar shows nothing.
 * Reading `error` for partial coverage collapsed amber into red and hid the
 * difference (invariant 13). The one case left pins that split; the rest of
 * this suite was wording and tone, which is review, not behaviour.
 */

import { describe, expect, it } from 'vitest';
import { pillView } from '../src/options/status';
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
});
