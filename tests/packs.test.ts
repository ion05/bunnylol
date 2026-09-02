/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import pack from '../extras/packs/removed-commands.json?raw';
import { importJson } from '../src/lib/storage';
import { BUILTIN_COMMANDS } from '../src/lib/commands';

describe('extras/packs/removed-commands.json', () => {
  it('parses through importJson', () => {
    expect(() => importJson(pack)).not.toThrow();
  });

  it('every entry declares non-empty keys, name and url', () => {
    const raw = JSON.parse(pack) as {
      overrides: { custom: Array<{ keys?: unknown; name?: unknown; url?: unknown }> };
    };
    expect(raw.overrides.custom.length).toBeGreaterThan(0);
    for (const entry of raw.overrides.custom) {
      expect(Array.isArray(entry.keys) && entry.keys.length > 0).toBe(true);
      expect(typeof entry.name === 'string' && entry.name.trim().length > 0).toBe(true);
      expect(typeof entry.url === 'string' && entry.url.trim().length > 0).toBe(true);
    }
  });

  it('every command in the pack keeps its aliases through normalisation', () => {
    const raw = JSON.parse(pack) as {
      overrides: { custom: Array<{ keys: string[]; category: string }> };
    };
    const imported = importJson(pack);
    expect(imported.overrides.custom.length).toBe(raw.overrides.custom.length);
    expect(imported.overrides.custom.map((cmd) => cmd.keys)).toEqual(
      raw.overrides.custom.map((entry) => entry.keys),
    );
    // Categories are plain strings in the pack's JSON, so removing a member
    // from `CATEGORIES` can't fail typecheck here the way it would for
    // `BUILTIN_COMMANDS` — normalizeCategory would silently reclassify these
    // entries as 'custom'. Assert the round trip so that reclassification is
    // a loud test failure instead.
    expect(imported.overrides.custom.map((cmd) => cmd.category)).toEqual(
      raw.overrides.custom.map((entry) => entry.category),
    );
  });

  it('no alias in the pack collides with a builtin', () => {
    const builtinAliases = new Set(BUILTIN_COMMANDS.flatMap((cmd) => cmd.keys));
    const imported = importJson(pack);
    const collisions = imported.overrides.custom
      .flatMap((cmd) => cmd.keys)
      .filter((alias) => builtinAliases.has(alias));
    expect(collisions).toEqual([]);
  });

  it('pack commands import as user shortcuts, not builtins', () => {
    const imported = importJson(pack);
    for (const cmd of imported.overrides.custom) {
      expect(cmd.builtin).toBe(false);
    }
  });
});
