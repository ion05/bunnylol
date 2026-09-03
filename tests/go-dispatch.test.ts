/// <reference types="vite/client" />
/**
 * The dispatch confirmation, "Confirm before opening a shortcut".
 *
 * `src/go/go.ts` cannot be imported: it reads `location.search` and calls
 * `location.replace` at module scope, and this suite runs under
 * `environment: 'node'`. So the page is pinned against its own source, the way
 * `tests/tokens.test.ts` already pins its stylesheet, which is enough for the
 * one regression that matters. The confirmation used to be a toast on a 1.2s
 * timer, and a timer is the obvious way to write this again.
 */

import { describe, expect, it } from 'vitest';
import goHtml from '../go.html?raw';
import goTs from '../src/go/go.ts?raw';

describe('the dispatch confirmation', () => {
  it('waits for the user rather than navigating on a timer', () => {
    expect(goTs).not.toContain('TOAST_MS');
    // The only timer left is the one that reveals "Opening…" when the storage
    // read is slow enough to be noticed. It does not navigate anything.
    expect(goTs.match(/setTimeout\(/g)).toHaveLength(1);
    expect(goTs).toContain('statusTimer = setTimeout(showStatus, STATUS_DELAY_MS)');
  });

  it('renders into a host go.html declares, and focuses its primary action', () => {
    // A confirmation rendered into an element that is not on the page is a
    // dispatch that never navigates, since the promise would never resolve.
    expect(goTs).toContain("getElementById('confirm')");
    expect(goHtml).toContain('id="confirm"');
    expect(goHtml).not.toContain('id="toast"');
    // Focused on load, so Enter proceeds without reaching for the mouse.
    expect(goTs).toContain('proceed.focus()');
  });

  it('keeps the escape to a plain search alongside it', () => {
    expect(goTs).toContain('Search for what you typed instead');
  });
});
