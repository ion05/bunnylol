/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import pack from '../extras/packs/removed-commands.json?raw';
import { importJson } from '../src/lib/storage';

describe('extras/packs/removed-commands.json', () => {
  it('parses through importJson', () => {
    expect(() => importJson(pack)).not.toThrow();
  });
});
