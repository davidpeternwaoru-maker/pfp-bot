/**
 * Deep link payload handling.
 *
 * The payload arrives as `/start <payload>` from anyone who can craft a link,
 * so it is fully attacker-controlled. It is validated into a slug here and
 * only ever used for an exact-match lookup — never interpolated into a query
 * pattern, a path, or a message.
 */

/** Telegram caps deep link payloads at 64 characters; we accept no more. */
export const MAX_SLUG_LENGTH = 64;

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export type PayloadRejection = 'missing' | 'too-long' | 'invalid-characters';

export type PayloadResult =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: PayloadRejection };

export function parseStartPayload(raw: string | undefined): PayloadResult {
  if (raw === undefined || raw.length === 0) {
    return { ok: false, reason: 'missing' };
  }

  // Length is checked before the pattern so a megabyte of junk is rejected
  // without running a regex over all of it.
  if (raw.length > MAX_SLUG_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }

  if (!SLUG_PATTERN.test(raw)) {
    return { ok: false, reason: 'invalid-characters' };
  }

  return { ok: true, slug: raw };
}

/** Telegram handles are 5-32 characters of letters, digits and underscores. */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,32}$/;

/**
 * Usernames are chosen by the user and change freely, so a stored one is only
 * ever a convenience. Anything not matching Telegram's own shape is dropped
 * rather than stored, so nothing unexpected reaches the database or a log.
 */
export function normaliseUsername(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  return USERNAME_PATTERN.test(raw) ? raw : null;
}
