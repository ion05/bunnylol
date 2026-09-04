import { describe, expect, it } from 'vitest';
import { at } from './helpers/at';
import { SEARCH_ENGINES } from '../src/lib/commands';
import MANIFEST from '../public/manifest.json';
import PKG from '../package.json';

/**
 * The manifest is the one file no test drives at runtime: the extension reads
 * it, the store validates it, and a mistake in it fails either silently (a
 * missing web-accessible resource just never loads) or after the upload has
 * already been rejected. These are the checks a reviewer would otherwise have
 * to make by eye.
 */
describe('manifest', () => {
  it('agrees with package.json about the version', () => {
    expect(MANIFEST.version).toBe(PKG.version);
  });

  it('carries a legal version string', () => {
    expect(MANIFEST.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const part of MANIFEST.version.split('.')) {
      expect(Number(part)).toBeLessThanOrEqual(65535);
      // Chrome rejects a leading zero in any part.
      expect(part).toBe(String(Number(part)));
    }
  });

  it('exposes only go.html to the web', () => {
    const war = at(MANIFEST.web_accessible_resources, 0);
    expect(MANIFEST.web_accessible_resources).toHaveLength(1);
    // go.js and assets/* are same-origin subresources of an extension page, so
    // go.html pulls them in on its own; listing them only let the three engines
    // probe them, sourcemaps included.
    expect(war.resources).toEqual(['go.html']);
    // `use_dynamic_url` would rotate the resource URL per site and break the
    // static `chrome-extension://<id>/go.html` substitution the redirect rules
    // are built from (`redirectRule` in src/lib/dnr/rules.ts).
    expect(war).not.toHaveProperty('use_dynamic_url');
  });

  it('scopes the resource and the host permissions to the engines it intercepts', () => {
    const origins = SEARCH_ENGINES.map((engine) => `https://${engine.host}/*`).sort();
    expect([...at(MANIFEST.web_accessible_resources, 0).matches].sort()).toEqual(origins);
    // A host permission the redirect rules do not use is an access grant the
    // store has to re-review, so widening this is a deliberate edit here first.
    expect([...MANIFEST.host_permissions].sort()).toEqual(origins);
  });

  it('has not grown a permission', () => {
    expect([...MANIFEST.permissions].sort()).toEqual(['declarativeNetRequest', 'storage']);
  });

  it('declares a homepage', () => {
    expect(MANIFEST.homepage_url).toMatch(/^https:\/\//);
  });

  it('keeps the description inside the store summary limit', () => {
    expect(MANIFEST.description.length).toBeLessThanOrEqual(132);
  });

  it('pins the floor Chrome version and an ES-module service worker', () => {
    // `light-dark()` is the floor, and it shipped in Chrome 123. Every colour
    // token is a light-dark() pair (`tests/tokens.test.ts` holds that end), and
    // a var() resolving to a colour function the engine cannot parse is invalid
    // at computed-value time: the property becomes `unset`, so backgrounds go
    // transparent and the switch's off state disappears. Lowering this number
    // does not degrade the UI, it breaks it.
    expect(MANIFEST.minimum_chrome_version).toBe('123');
    expect(MANIFEST.background.type).toBe('module');
  });
});
