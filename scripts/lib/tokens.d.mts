/**
 * `tsc` does not read the .mjs beside this file (`allowJs` is off, and turning
 * it on would typecheck every build script), but tests/tokens.test.ts imports
 * it, so the one exported function is declared here.
 */
export function readFlatHex(css: string, name: string): number[];
