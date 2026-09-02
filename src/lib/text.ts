/**
 * Small string helpers shared by every surface. Pure; the only import is
 * `stripPassthrough`, because a URL shown to a user must never display our own
 * plumbing.
 */

import { stripPassthrough } from './resolve';

/** The keyword: text up to the first whitespace, matching `resolve()`'s split. */
export function firstToken(text: string): string {
  const trimmed = text.trim();
  const boundary = trimmed.search(/\s/);
  return boundary < 0 ? trimmed : trimmed.slice(0, boundary);
}

/** Everything after the keyword, trimmed. '' when there is no whitespace. */
export function restOfLine(text: string): string {
  const trimmed = text.trim();
  const boundary = trimmed.search(/\s/);
  return boundary < 0 ? '' : trimmed.slice(boundary + 1).trim();
}

/** A URL without its scheme, for display only. Never navigated to. */
export function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/** `stripScheme` plus the passthrough marker removed. */
export function prettyUrl(url: string): string {
  // The passthrough marker is plumbing; showing `&blpass=1` in every fallback
  // preview would just look like a bug to the user.
  return stripScheme(stripPassthrough(url));
}

/** An unknown thrown value as a message safe to show. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A structural copy, so a caller cannot mutate a shared default in place. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
