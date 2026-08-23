/**
 * The vocabulary of the claim taxonomy.
 *
 * Kept here rather than imported from the generated Prisma enums for the same
 * reason TraitTier is: core's types are the product's types, and a front end
 * or a test must be able to speak them without a database in the room.
 */

export const CLAIM_TYPES = ['open', 'bespoke', 'custom'] as const;

/**
 * How a claim's artwork was produced. Production, not selection: a legendary
 * an operator hands out is still `open`, because it was composited from trait
 * rows. What makes it an award is its tier and the fact that it occupies no
 * member slot. The invariant that buys is exact — `open` if and only if the
 * claim has a trait combination.
 */
export type ClaimType = (typeof CLAIM_TYPES)[number];

/**
 * A member holds at most one claim in each of these per project.
 *
 * Two slots rather than one because an open-pool claim and a commission are
 * different purchases: the project paid for one, the member paid for the
 * other, and holding one must not consume the right to the other.
 */
export type MemberSlot = 'open' | 'custom';

/**
 * The value the (projectId, memberSlotKey) unique index is built on.
 *
 * The slot name is encoded into the key rather than being a second column
 * because Postgres treats nulls as distinct: a claim that occupies no slot
 * writes null and is therefore exempt from the index entirely, while these two
 * keys never collide with each other. That is what lets one member hold a
 * rolled claim and a commissioned one while a second of either is refused by
 * the database rather than by a check that could race.
 */
export function memberSlotKey(memberId: number, slot: MemberSlot): string {
  return `${String(memberId)}:${slot}`;
}
