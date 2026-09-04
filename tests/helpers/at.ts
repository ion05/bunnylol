/**
 * The one narrowing helper the suites share, for reading `list[i]` under
 * `noUncheckedIndexedAccess`.
 *
 * It THROWS rather than substituting a default. A test that reaches past the
 * end of a list has already found something, and a stand-in value would turn
 * that finding into an assertion about an object nobody produced. The message
 * carries the index and the length, because "expected undefined to be 'u:pay'"
 * does not say that the list was empty.
 *
 * Not a suite: vitest only collects files ending in `.test.ts`.
 */

export function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`nothing at index ${index} of ${list.length}`);
  }
  return item;
}
