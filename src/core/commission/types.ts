/**
 * The vocabulary of a commission.
 *
 * Mirrors the Prisma enums for the same reason the claim types do: core's
 * types are the product's types, and a front end or a test must be able to
 * speak them without a database in the room.
 */

export const COMMISSION_STATUSES = [
  'awaiting_payment',
  'awaiting_approval',
  'approved',
  'in_production',
  'delivered',
  'declined',
  'cancelled',
] as const;

export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export const DECLINE_REASONS = [
  'copyrighted_material',
  'real_person',
  'prohibited_content',
  'rival_branding',
  'not_producible',
  'brief_unclear',
] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number];

/**
 * A status nothing moves out of.
 *
 * Terminal states are what release the member's one live-order slot, so this
 * is not merely descriptive — getting it wrong would either strand a member
 * who can never order again, or let one hold two orders at once.
 */
export function isTerminal(status: CommissionStatus): boolean {
  return status === 'delivered' || status === 'declined' || status === 'cancelled';
}

/**
 * The colours a member may choose from.
 *
 * A fixed palette rather than a colour picker, and not for tidiness: an
 * arbitrary hex value is a value an illustrator has to interpret, and
 * interpreting is the conversation this design exists to remove. Named
 * colours are also what a decline can refer back to without ambiguity.
 */
export const COMMISSION_PALETTE = [
  'black',
  'white',
  'grey',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'brown',
  'gold',
  'silver',
] as const;

export type CommissionColour = (typeof COMMISSION_PALETTE)[number];

export function isPaletteColour(value: string): value is CommissionColour {
  return (COMMISSION_PALETTE as readonly string[]).includes(value);
}

/** 0 is the original brief; 1 is the single revision a member may request. */
export const MAX_REVISION = 1;
