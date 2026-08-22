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
const SLOT_PREFIX = 's';

/** Telegram's own ceiling is 64 bytes; ours is far below it. */
const MAX_CALLBACK_DATA_LENGTH = 8;

const SLOT_PATTERN = /^s(\d{1,2})$/;

export type CallbackAction =
  | { readonly kind: 'reroll' }
  | { readonly kind: 'claim' }
  | { readonly kind: 'cycle-slot'; readonly slotIndex: number };

export function slotAction(slotIndex: number): string {
  return `${SLOT_PREFIX}${String(slotIndex)}`;
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
