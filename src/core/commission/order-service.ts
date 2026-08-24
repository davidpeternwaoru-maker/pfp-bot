import { canTransition, occupiesOrderSlot } from './lifecycle.js';
import { monthStart } from './eligibility.js';
import type { CommissionStatus, DeclineReason } from './types.js';
import type { ValidBrief } from './brief.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Placing and moving a commission.
 *
 * Two things here are enforced by the database rather than by checking first
 * and writing after, and both are things the plan asks to hold under
 * concurrency:
 *
 * Monthly capacity is counted inside a transaction that holds the project row
 * lock, so two members ordering the same instant queue rather than both read
 * the same count and both slip through the last slot.
 *
 * One live order per member is the (projectId, openOrderKey) unique index. A
 * check-then-insert would race exactly the same way, and losing that race
 * would give one member two of a capacity the project promised everybody.
 *
 * Every status change is a conditional UPDATE naming the status it expects to
 * find, so an operator approving a commission somebody else has just declined
 * gets told, rather than quietly overwriting the decline.
 */

/** Matches the claim path: a burst queues on a row lock and needs the room. */
const TRANSACTION_TIMEOUT_MS = 20_000;
const TRANSACTION_MAX_WAIT_MS = 15_000;

export interface PlaceOrderInput {
  readonly prisma: PrismaClient;
  readonly projectId: number;
  readonly memberId: number;
  readonly brief: ValidBrief;
  /** Copied onto the order so later price changes cannot restate this one. */
  readonly priceUsdcCents: number;
  readonly treasuryShareBps: number;
  readonly monthlyCapacity: number;
  readonly now?: Date;
}

export type PlaceOrderOutcome =
  | { readonly kind: 'ordered'; readonly commissionId: number }
  /** The month filled while they were answering the questionnaire. */
  | { readonly kind: 'at-capacity' }
  /** They already hold a live order here. */
  | { readonly kind: 'already-ordered' }
  | { readonly kind: 'project-missing' };

/**
 * Creates the commission and its original brief together.
 *
 * One transaction, because a commission with no brief is an order nobody can
 * produce and a brief with no commission is an answer to nothing.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderOutcome> {
  const { prisma, projectId, memberId, brief } = input;
  const now = input.now ?? new Date();

  try {
    const created = await prisma.$transaction(
      async (tx) => {
        // Locks the project for the rest of the transaction, exactly as a
        // claim does. Without it, two concurrent orders read the same count
        // and both take what turns out to be the same last slot.
        const projects = await tx.$queryRaw<
          { id: number }[]
        >`SELECT "id" FROM "Project" WHERE id = ${projectId} FOR UPDATE`;

        if (projects[0] === undefined) {
          return null;
        }

        // Counted inside the lock, so the number cannot move underneath the
        // comparison that follows it.
        const acceptedThisMonth = await tx.commission.count({
          where: {
            projectId,
            createdAt: { gte: monthStart(now) },
            // A withdrawn order never consumed a slot, so it must not hold one
            // against the month it was withdrawn in.
            status: { not: 'cancelled' },
          },
        });

        if (input.monthlyCapacity <= 0 || acceptedThisMonth >= input.monthlyCapacity) {
          return { full: true as const };
        }

        const commission = await tx.commission.create({
          data: {
            projectId,
            memberId,
            status: 'awaiting_payment',
            priceUsdcCents: input.priceUsdcCents,
            treasuryShareBps: input.treasuryShareBps,
            // Holds the member's one live-order slot until this reaches a
            // terminal state. Set here and cleared in exactly one other place.
            openOrderKey: String(memberId),
            briefs: {
              create: {
                revision: 0,
                slot: brief.slot,
                textContent: brief.textContent,
                colour: brief.colour,
                referencePath: brief.referencePath,
                note: brief.note,
              },
            },
          },
          select: { id: true },
        });

        return { full: false as const, id: commission.id };
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );

    if (created === null) {
      return { kind: 'project-missing' };
    }
    if (created.full) {
      return { kind: 'at-capacity' };
    }
    return { kind: 'ordered', commissionId: created.id };
  } catch (error) {
    // The one-live-order index refused it. Reported rather than thrown: a
    // member with an order already open has done nothing wrong.
    if (isUniqueViolation(error)) {
      return { kind: 'already-ordered' };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return (error as { code?: unknown }).code === 'P2002';
}

export interface TransitionInput {
  readonly prisma: PrismaClient;
  readonly commissionId: number;
  /** The status this caller believes it is in. Checked by the database. */
  readonly from: CommissionStatus;
  readonly to: CommissionStatus;
  readonly declineReason?: DeclineReason | undefined;
  readonly paymentReference?: string | undefined;
  readonly deliveredClaimId?: number | undefined;
  readonly now?: Date;
}

export type TransitionOutcome =
  | { readonly kind: 'moved' }
  /** The move is not one the lifecycle allows at all. */
  | { readonly kind: 'illegal' }
  /** It was not in `from` any more — somebody else moved it first. */
  | { readonly kind: 'stale'; readonly actual: CommissionStatus | null };

/**
 * Moves a commission, or explains why it did not move.
 *
 * The expected status is part of the WHERE clause rather than something read
 * beforehand, so two operators acting on the same queue entry produce one
 * winner and one honest "somebody got there first" — not a decline silently
 * overwritten by an approval half a second later.
 */
export async function transitionCommission(input: TransitionInput): Promise<TransitionOutcome> {
  const { prisma, commissionId, from, to } = input;
  const now = input.now ?? new Date();

  // Refused before touching the database. An illegal move is a bug in the
  // caller, not a race, and the two should never look alike.
  if (!canTransition(from, to)) {
    return { kind: 'illegal' };
  }

  const data: Record<string, unknown> = { status: to };

  // Timestamps are set by the transition that earns them, so no later code
  // has to infer when something happened from the status alone.
  if (to === 'awaiting_approval') {
    data['paidAt'] = now;
    if (input.paymentReference !== undefined) {
      data['paymentReference'] = input.paymentReference;
    }
  }
  if (to === 'approved') {
    data['approvedAt'] = now;
  }
  if (to === 'in_production') {
    data['startedAt'] = now;
  }
  if (to === 'declined') {
    data['declinedAt'] = now;
    if (input.declineReason !== undefined) {
      data['declineReason'] = input.declineReason;
    }
  }
  if (to === 'delivered') {
    data['deliveredAt'] = now;
    if (input.deliveredClaimId !== undefined) {
      data['deliveredClaimId'] = input.deliveredClaimId;
    }
  }

  // Terminal states release the member's live-order slot. Cleared in exactly
  // one place, so there is no path that ends an order while still holding it.
  if (!occupiesOrderSlot(to)) {
    data['openOrderKey'] = null;
  }

  const { count } = await prisma.commission.updateMany({
    where: { id: commissionId, status: from },
    data,
  });

  if (count > 0) {
    return { kind: 'moved' };
  }

  // Report what it actually is, so the caller can say something useful rather
  // than "that did not work".
  const actual = await prisma.commission.findUnique({
    where: { id: commissionId },
    select: { status: true },
  });

  return { kind: 'stale', actual: actual?.status ?? null };
}

export type RevisionOutcome =
  | { readonly kind: 'recorded' }
  /** The one revision has already been used. */
  | { readonly kind: 'already-revised' }
  /** Revisions only make sense while the piece is still being made. */
  | { readonly kind: 'wrong-status'; readonly actual: CommissionStatus };

/**
 * Records the single revision a member is allowed.
 *
 * The cap is held by the (commissionId, revision) unique index rather than by
 * counting first. Unlimited revisions is how a self-serve system quietly turns
 * into the operator mediating a design argument, so the limit is the kind of
 * thing that should be impossible to exceed rather than merely checked.
 */
export async function addRevision(
  prisma: PrismaClient,
  commissionId: number,
  brief: ValidBrief,
): Promise<RevisionOutcome> {
  const commission = await prisma.commission.findUnique({
    where: { id: commissionId },
    select: { status: true },
  });

  if (commission === null) {
    return { kind: 'wrong-status', actual: 'cancelled' };
  }

  // Before approval there is nothing to revise, and after delivery it is too
  // late — a revision then is a new order, at full price.
  if (commission.status !== 'approved' && commission.status !== 'in_production') {
    return { kind: 'wrong-status', actual: commission.status };
  }

  try {
    await prisma.commissionBrief.create({
      data: {
        commissionId,
        revision: 1,
        slot: brief.slot,
        textContent: brief.textContent,
        colour: brief.colour,
        referencePath: brief.referencePath,
        note: brief.note,
      },
    });
    return { kind: 'recorded' };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { kind: 'already-revised' };
    }
    throw error;
  }
}
