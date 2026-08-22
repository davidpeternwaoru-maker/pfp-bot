/**
 * Callback data is attacker-controlled: anyone can craft a callback query with
 * arbitrary bytes in it. So it carries an action identifier and nothing else —
 * no trait ids, no combination, no member id. What the member is actually
 * holding is read from server-side session state, which they cannot touch.
 *
 * A slot button's index is part of which button was pressed, not state, and it
 * is bounds-checked against the pack before use.
 */

export const REROLL = 'r';
export const CLAIM = 'c';
export const CONFIRM_CLAIM = 'k';
export const CANCEL_CLAIM = 'x';
const SLOT_PREFIX = 's';
const COLLECTION_PAGE_PREFIX = 'g';

/** Telegram's own ceiling is 64 bytes; ours is far below it. */
const MAX_CALLBACK_DATA_LENGTH = 8;

const SLOT_PATTERN = /^s(\d{1,2})$/;
const COLLECTION_PAGE_PATTERN = /^g(\d{1,3})$/;

export type CallbackAction =
  | { readonly kind: 'collection-page'; readonly pageIndex: number }
  | { readonly kind: 'reroll' }
  | { readonly kind: 'claim' }
  | { readonly kind: 'confirm-claim' }
  | { readonly kind: 'cancel-claim' }
  | { readonly kind: 'cycle-slot'; readonly slotIndex: number };

export function slotAction(slotIndex: number): string {
  return `${SLOT_PREFIX}${String(slotIndex)}`;
}

export function collectionPageAction(pageIndex: number): string {
  return `${COLLECTION_PAGE_PREFIX}${String(pageIndex)}`;
}

/**
 * Collection paging is parsed separately from the rolling actions: it belongs
 * to a message with no session behind it, so it must be recognisable before
 * any session lookup happens.
 */
export function parseCollectionPage(raw: string | undefined): number | null {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_CALLBACK_DATA_LENGTH) {
    return null;
  }
  const match = COLLECTION_PAGE_PATTERN.exec(raw);
  if (match === null) {
    return null;
  }
  const pageIndex = Number(match[1]);
  // Only the shape is checked here. Which pages exist depends on how many
  // claims the member holds, which is server-side state, so the page is
  // clamped against that rather than trusted from the payload.
  return Number.isSafeInteger(pageIndex) && pageIndex >= 0 ? pageIndex : null;
}

/**
 * Returns null for anything unrecognised — wrong shape, oversized, or a slot
 * index outside this pack. Callers treat null as "ignore", never as a default
 * action.
 */
export function parseCallbackData(
  raw: string | undefined,
  slotCount: number,
): CallbackAction | null {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_CALLBACK_DATA_LENGTH) {
    return null;
  }

  if (raw === REROLL) {
    return { kind: 'reroll' };
  }

  if (raw === CLAIM) {
    return { kind: 'claim' };
  }

  if (raw === CONFIRM_CLAIM) {
    return { kind: 'confirm-claim' };
  }

  if (raw === CANCEL_CLAIM) {
    return { kind: 'cancel-claim' };
  }

  const match = SLOT_PATTERN.exec(raw);
  if (match === null) {
    return null;
  }

  const slotIndex = Number(match[1]);
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= slotCount) {
    return null;
  }

  return { kind: 'cycle-slot', slotIndex };
}
