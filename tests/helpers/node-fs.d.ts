/**
 * The one node builtin the test suite needs, declared here because the repo
 * has no `@types/node` and takes no new dependencies (AGENTS.md). Reading the
 * bundled font as bytes is the only thing this buys: Vite's `?raw` decodes a
 * woff2 as UTF-8, which folds every invalid byte into U+FFFD and so cannot see
 * roughly two in five single-byte differences. Hashing is done with the Web
 * Crypto that `lib.dom` already types.
 */
declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array<ArrayBuffer>;
}
