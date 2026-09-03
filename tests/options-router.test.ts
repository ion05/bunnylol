/**
 * `parseRoute` is the whole of the options page's routing: the head of the
 * hash decides which view renders, and anything it does not recognise has to
 * land on the shortcut list rather than on a blank page.
 *
 * What is pinned here is that the two pack screens are two routes. They ask the
 * same question and write the same answer, so folding `#packs` into `#welcome`
 * as an alias looks harmless, and it is not: it would hand a returning user the
 * first-run introduction and a Skip button.
 */

import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/options/router';

describe('parseRoute', () => {
  it('routes the two pack screens separately', () => {
    expect(parseRoute('#welcome').name).toBe('welcome');
    expect(parseRoute('#packs').name).toBe('packs');
  });

  it('reads the head of the hash, not the whole of it', () => {
    expect(parseRoute('#Packs').name).toBe('packs');
    expect(parseRoute('#packs?from=settings').name).toBe('packs');
    expect(parseRoute('#packs?from=settings').params.get('from')).toBe('settings');
  });

  it('falls back to the shortcut list on anything else', () => {
    expect(parseRoute('#pack').name).toBe('help');
    expect(parseRoute('#').name).toBe('help');
    expect(parseRoute('').name).toBe('help');
  });
});
