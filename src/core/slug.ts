/**
 * Project slug rules.
 *
 * A slug is the public name of a project in any front end: a deep link
 * payload, a URL segment, a command argument. Every one of those is
 * attacker-controlled, so the rule lives in one place and is applied
 * everywhere rather than re-stated per adapter.
 */

/**
 * 64 characters, which is Telegram's deep link ceiling and comfortably under
 * anything a URL would impose. Shared as the common denominator so a slug that
 * works in one front end works in all of them.
 */
export const MAX_SLUG_LENGTH = 64;

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export type SlugRejection = 'missing' | 'too-long' | 'invalid-characters';

export type SlugResult =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: SlugRejection };

export function parseSlug(raw: string | undefined): SlugResult {
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
