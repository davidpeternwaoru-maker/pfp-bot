/**
 * Callback data is attacker-controlled: anyone can craft a callback query with
 * arbitrary bytes in it. So it carries an action identifier and nothing else —
 * no trait ids, no combination, no member id. What the member is actually
 * holding is read from server-side session state, which they cannot touch.
 *
 * A slot button's index is part of which button was pressed, not state, and it
 * is bounds-checked against the pack before use.
 *
 * Browsing follows the same rule and needs it more, because a list of options
 * is exactly where trait ids would be convenient to encode. They are not
 * encoded. A page button carries a page number, and an option button carries a
 * position on the page — resolved against the slot and page the server itself
 * last drew and recorded in the session. There is no id in the payload to
 * tamper with, so the worst a forged one can do is choose a different option in
 * a list the member already had open.
 */

export const REROLL = 'r';
export const CLAIM = 'c';
export const CONFIRM_CLAIM = 'k';
export const CANCEL_CLAIM = 'x';
export const CLOSE_BROWSE = 'q';
export const WALLET_LINK = 'w';

/**
 * Commission actions, member side.
 *
 * Positions, never values. A slot button carries its index in the project's
 * eligible list and a colour button its index in the palette, both resolved
 * server-side against the same lists the server drew — so a forged payload can
 * only ever pick a different option from a list the member already had open,
 * and never introduce a slot the project never offered.
 */
export const COMMISSION_SKIP = 'mk';
export const COMMISSION_ORDER = 'mo';
export const COMMISSION_ABANDON = 'mx';
export const COMMISSION_WAITLIST = 'mw';
const COMMISSION_SLOT_PREFIX = 'ms';
const COMMISSION_COLOUR_PREFIX = 'mc';

/**
 * Operator queue actions.
 *
 * None of these names a commission. Which one is on screen is held in the
 * operator's own session, so a payload cannot address somebody else's order —
 * and authorisation still comes from the sender, never from the button.
 */
export const QUEUE_PAID = 'np';
export const QUEUE_APPROVE = 'na';
export const QUEUE_DECLINE = 'nd';
export const QUEUE_PRODUCE = 'ns';
export const QUEUE_NEXT = 'nn';
export const QUEUE_BACK = 'nb';
const QUEUE_REASON_PREFIX = 'nr';
const SLOT_PREFIX = 's';
const BROWSE_PREFIX = 'b';
const PAGE_PREFIX = 'p';
const OPTION_PREFIX = 'o';
const COLLECTION_PAGE_PREFIX = 'g';

/** Telegram's own ceiling is 64 bytes; ours is far below it. */
const MAX_CALLBACK_DATA_LENGTH = 8;

const SLOT_PATTERN = /^s(\d{1,2})$/;
const BROWSE_PATTERN = /^b(\d{1,2})$/;
const PAGE_PATTERN = /^p(\d{1,3})$/;
const OPTION_PATTERN = /^o(\d{1,2})$/;
const COLLECTION_PAGE_PATTERN = /^g(\d{1,3})$/;
const COMMISSION_SLOT_PATTERN = /^ms(\d{1,2})$/;
const COMMISSION_COLOUR_PATTERN = /^mc(\d{1,2})$/;
const QUEUE_REASON_PATTERN = /^nr(\d{1,2})$/;

export type CallbackAction =
  | { readonly kind: 'collection-page'; readonly pageIndex: number }
  | { readonly kind: 'reroll' }
  | { readonly kind: 'claim' }
  | { readonly kind: 'confirm-claim' }
  | { readonly kind: 'cancel-claim' }
  | { readonly kind: 'cycle-slot'; readonly slotIndex: number }
  | { readonly kind: 'open-browse'; readonly slotIndex: number }
  | { readonly kind: 'browse-page'; readonly pageIndex: number }
  | { readonly kind: 'pick-option'; readonly positionOnPage: number }
  | { readonly kind: 'close-browse' }
  | { readonly kind: 'wallet-link' }
  | { readonly kind: 'commission-slot'; readonly position: number }
  | { readonly kind: 'commission-colour'; readonly position: number }
  | { readonly kind: 'commission-skip' }
  | { readonly kind: 'commission-order' }
  | { readonly kind: 'commission-abandon' }
  | { readonly kind: 'commission-waitlist' }
  | { readonly kind: 'queue-paid' }
  | { readonly kind: 'queue-approve' }
  | { readonly kind: 'queue-decline' }
  | { readonly kind: 'queue-reason'; readonly position: number }
  | { readonly kind: 'queue-produce' }
  | { readonly kind: 'queue-next' }
  | { readonly kind: 'queue-back' };

export function slotAction(slotIndex: number): string {
  return `${SLOT_PREFIX}${String(slotIndex)}`;
}

export function browseAction(slotIndex: number): string {
  return `${BROWSE_PREFIX}${String(slotIndex)}`;
}

export function browsePageAction(pageIndex: number): string {
  return `${PAGE_PREFIX}${String(pageIndex)}`;
}

export function optionAction(positionOnPage: number): string {
  return `${OPTION_PREFIX}${String(positionOnPage)}`;
}

export function commissionSlotAction(position: number): string {
  return `${COMMISSION_SLOT_PREFIX}${String(position)}`;
}

export function commissionColourAction(position: number): string {
  return `${COMMISSION_COLOUR_PREFIX}${String(position)}`;
}

export function queueReasonAction(position: number): string {
  return `${QUEUE_REASON_PREFIX}${String(position)}`;
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

/** A non-negative integer captured by one of the patterns above, or null. */
function indexFrom(match: RegExpExecArray | null): number | null {
  if (match === null) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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

  if (raw === CLOSE_BROWSE) {
    return { kind: 'close-browse' };
  }

  if (raw === WALLET_LINK) {
    return { kind: 'wallet-link' };
  }

  if (raw === COMMISSION_SKIP) {
    return { kind: 'commission-skip' };
  }
  if (raw === COMMISSION_ORDER) {
    return { kind: 'commission-order' };
  }
  if (raw === COMMISSION_ABANDON) {
    return { kind: 'commission-abandon' };
  }
  if (raw === COMMISSION_WAITLIST) {
    return { kind: 'commission-waitlist' };
  }

  if (raw === QUEUE_PAID) {
    return { kind: 'queue-paid' };
  }
  if (raw === QUEUE_APPROVE) {
    return { kind: 'queue-approve' };
  }
  if (raw === QUEUE_DECLINE) {
    return { kind: 'queue-decline' };
  }
  if (raw === QUEUE_PRODUCE) {
    return { kind: 'queue-produce' };
  }
  if (raw === QUEUE_NEXT) {
    return { kind: 'queue-next' };
  }
  if (raw === QUEUE_BACK) {
    return { kind: 'queue-back' };
  }

  // Positions again, resolved against what the server last drew. Bounds are
  // not checked here because this function cannot see those lists.
  const commissionSlot = indexFrom(COMMISSION_SLOT_PATTERN.exec(raw));
  if (commissionSlot !== null) {
    return { kind: 'commission-slot', position: commissionSlot };
  }

  const commissionColour = indexFrom(COMMISSION_COLOUR_PATTERN.exec(raw));
  if (commissionColour !== null) {
    return { kind: 'commission-colour', position: commissionColour };
  }

  const queueReason = indexFrom(QUEUE_REASON_PATTERN.exec(raw));
  if (queueReason !== null) {
    return { kind: 'queue-reason', position: queueReason };
  }

  // A slot index addresses the pack, so it is bounds-checked here. A page or a
  // position addresses what the server last drew, which this function cannot
  // see, so those carry only their shape and are resolved against the session.
  const slotIndex = indexFrom(SLOT_PATTERN.exec(raw));
  if (slotIndex !== null) {
    return slotIndex < slotCount ? { kind: 'cycle-slot', slotIndex } : null;
  }

  const browseIndex = indexFrom(BROWSE_PATTERN.exec(raw));
  if (browseIndex !== null) {
    return browseIndex < slotCount ? { kind: 'open-browse', slotIndex: browseIndex } : null;
  }

  const pageIndex = indexFrom(PAGE_PATTERN.exec(raw));
  if (pageIndex !== null) {
    return { kind: 'browse-page', pageIndex };
  }

  const positionOnPage = indexFrom(OPTION_PATTERN.exec(raw));
  if (positionOnPage !== null) {
    return { kind: 'pick-option', positionOnPage };
  }

  return null;
}
