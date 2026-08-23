import { parseSlug } from '../../core/ports.js';
import type { SlugResult } from '../../core/ports.js';

/**
 * Telegram-specific input handling.
 *
 * The deep link payload arrives as `/start <payload>` from anyone who can
 * craft a link, so it is fully attacker-controlled. It is validated into a
 * slug by the shared core rule and only ever used for an exact-match lookup —
 * never interpolated into a query pattern, a path, or a message.
 */

export type PayloadResult = SlugResult;

export function parseStartPayload(raw: string | undefined): PayloadResult {
  return parseSlug(raw);
}

/** Telegram handles are up to 32 characters of letters, digits and underscores. */
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
