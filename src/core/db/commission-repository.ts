import { monthStart } from '../commission/eligibility.js';
import { formatUsdc, owesRefund, treasuryShareCents } from '../commission/lifecycle.js';
import type { CommissionTerms } from '../commission/eligibility.js';
import type { CommissionStatus, DeclineReason } from '../commission/types.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Reading commissions: what a member is owed, what an operator must act on,
 * and what the project is owed.
 *
 * Reads only. Every write goes through order-service, where the guarantees
 * about capacity and single-use transitions live.
 */

/** A project's commission terms, or null when it sells none. */
export async function findCommissionTerms(
  prisma: PrismaClient,
  projectId: number,
): Promise<CommissionTerms | null> {
  const row = await prisma.commissionSettings.findUnique({
    where: { projectId },
    select: {
      enabled: true,
      priceUsdcCents: true,
      treasuryShareBps: true,
      monthlyCapacity: true,
      eligibleSlots: true,
      tokenMint: true,
      tokenMinimum: true,
    },
  });

  return row === null ? null : { ...row, eligibleSlots: row.eligibleSlots };
}

/**
 * Commissions counted against this month's capacity.
 *
 * Cancelled orders are excluded: a member who withdrew before paying never
 * consumed a slot, and holding one against the month would quietly shrink the
 * capacity a project advertised.
 */
export async function countAcceptedThisMonth(
  prisma: PrismaClient,
  projectId: number,
  now: Date = new Date(),
): Promise<number> {
  return prisma.commission.count({
    where: {
      projectId,
      createdAt: { gte: monthStart(now) },
      status: { not: 'cancelled' },
    },
  });
}

export interface BriefView {
  readonly revision: number;
  readonly slot: string;
  readonly textContent: string | null;
  readonly colour: string | null;
  readonly referencePath: string | null;
  readonly note: string | null;
}

export interface CommissionView {
  readonly id: number;
  readonly projectId: number;
  readonly projectName: string;
  readonly memberId: number;
  readonly status: CommissionStatus;
  readonly priceUsdcCents: number;
  readonly treasuryShareBps: number;
  readonly paymentReference: string | null;
  readonly paidAt: Date | null;
  readonly declineReason: DeclineReason | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
  /** Newest first, so index 0 is what should actually be produced. */
  readonly briefs: readonly BriefView[];
}

const COMMISSION_SELECT = {
  id: true,
  projectId: true,
  memberId: true,
  status: true,
  priceUsdcCents: true,
  treasuryShareBps: true,
  paymentReference: true,
  paidAt: true,
  declineReason: true,
  deliveredAt: true,
  createdAt: true,
  project: { select: { name: true } },
  briefs: {
    orderBy: { revision: 'desc' },
    select: {
      revision: true,
      slot: true,
      textContent: true,
      colour: true,
      referencePath: true,
      note: true,
    },
  },
} as const;

type CommissionRow = {
  readonly project: { readonly name: string };
  readonly briefs: readonly BriefView[];
} & Omit<CommissionView, 'projectName' | 'briefs'>;

function toView(row: CommissionRow): CommissionView {
  const { project, ...rest } = row;
  return { ...rest, projectName: project.name };
}

/** The live order a member holds here, if any. */
export async function findOpenCommission(
  prisma: PrismaClient,
  projectId: number,
  memberId: number,
): Promise<CommissionView | null> {
  const row = await prisma.commission.findUnique({
    // Reads through the same index that enforces one live order per member.
    where: { projectId_openOrderKey: { projectId, openOrderKey: String(memberId) } },
    select: COMMISSION_SELECT,
  });

  return row === null ? null : toView(row);
}

/** Everything a member has ever ordered here, newest first. */
export async function findMemberCommissions(
  prisma: PrismaClient,
  memberId: number,
): Promise<readonly CommissionView[]> {
  const rows = await prisma.commission.findMany({
    where: { memberId },
    orderBy: { createdAt: 'desc' },
    select: COMMISSION_SELECT,
  });

  return rows.map((row) => toView(row));
}

export async function findCommission(
  prisma: PrismaClient,
  commissionId: number,
): Promise<CommissionView | null> {
  const row = await prisma.commission.findUnique({
    where: { id: commissionId },
    select: COMMISSION_SELECT,
  });

  return row === null ? null : toView(row);
}

/**
 * What the operator has to act on, oldest first.
 *
 * Oldest first because a queue that surfaced the newest would leave the person
 * who has waited longest waiting longest, which is the opposite of a queue.
 */
export async function findOperatorQueue(
  prisma: PrismaClient,
  projectId?: number,
): Promise<readonly CommissionView[]> {
  const rows = await prisma.commission.findMany({
    where: {
      // Awaiting payment is included because confirming USDC arrived is an
      // operator action too. Leaving it out would mean nothing ever reached
      // the queue at all — an order would sit unpaid forever with no button
      // anywhere able to move it.
      status: { in: ['awaiting_payment', 'awaiting_approval', 'approved', 'in_production'] },
      ...(projectId === undefined ? {} : { projectId }),
    },
    orderBy: { createdAt: 'asc' },
    select: COMMISSION_SELECT,
  });

  return rows.map((row) => toView(row));
}

export interface PayableLine {
  readonly commissionId: number;
  readonly projectName: string;
  readonly kind: 'treasury-share' | 'member-refund';
  readonly amountCents: number;
  readonly amount: string;
  readonly since: Date;
}

export interface PayablesReport {
  readonly lines: readonly PayableLine[];
  readonly treasuryOwedCents: number;
  readonly refundsOwedCents: number;
}

/**
 * What is owed and to whom.
 *
 * Two kinds of line, and they are not netted against each other. A refund owed
 * to a member and a share owed to a project are different debts to different
 * people, and a single combined figure would hide one behind the other.
 *
 * Reported, never paid. The plan is explicit that this must be auditable
 * before it is automatic, and nothing here moves money.
 */
export async function payablesReport(
  prisma: PrismaClient,
  projectId?: number,
): Promise<PayablesReport> {
  const rows = await prisma.commission.findMany({
    where: {
      // Delivered work earns the project its share; a paid-for decline owes
      // the member their money back. Nothing else is owed to anybody.
      OR: [{ status: 'delivered' }, { status: 'declined', paidAt: { not: null } }],
      refundedAt: null,
      ...(projectId === undefined ? {} : { projectId }),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      priceUsdcCents: true,
      treasuryShareBps: true,
      paidAt: true,
      deliveredAt: true,
      declinedAt: true,
      createdAt: true,
      project: { select: { name: true } },
    },
  });

  const lines: PayableLine[] = [];
  let treasuryOwedCents = 0;
  let refundsOwedCents = 0;

  for (const row of rows) {
    if (owesRefund(row.status, row.paidAt)) {
      // The whole price back. A decline is the project's decision, so the
      // member carries none of its cost.
      const amountCents = row.priceUsdcCents;
      refundsOwedCents += amountCents;
      lines.push({
        commissionId: row.id,
        projectName: row.project.name,
        kind: 'member-refund',
        amountCents,
        amount: formatUsdc(amountCents),
        since: row.declinedAt ?? row.createdAt,
      });
      continue;
    }

    if (row.status === 'delivered') {
      const amountCents = treasuryShareCents(row.priceUsdcCents, row.treasuryShareBps);
      if (amountCents > 0) {
        treasuryOwedCents += amountCents;
        lines.push({
          commissionId: row.id,
          projectName: row.project.name,
          kind: 'treasury-share',
          amountCents,
          amount: formatUsdc(amountCents),
          since: row.deliveredAt ?? row.createdAt,
        });
      }
    }
  }

  return { lines, treasuryOwedCents, refundsOwedCents };
}

/** Members waiting for next month's capacity, oldest first. */
export async function findWaitlist(
  prisma: PrismaClient,
  projectId: number,
): Promise<readonly { readonly memberId: number; readonly since: Date }[]> {
  const rows = await prisma.commissionWaitlist.findMany({
    where: { projectId, notifiedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { memberId: true, createdAt: true },
  });

  return rows.map((row) => ({ memberId: row.memberId, since: row.createdAt }));
}

/**
 * Adds a member to the waitlist, or leaves them where they are.
 *
 * Idempotent, and it must be: somebody who taps "tell me when it opens" twice
 * has asked once, and moving them to the back of the queue for asking again
 * would punish enthusiasm.
 */
export async function joinWaitlist(
  prisma: PrismaClient,
  projectId: number,
  memberId: number,
): Promise<void> {
  await prisma.commissionWaitlist.upsert({
    where: { projectId_memberId: { projectId, memberId } },
    create: { projectId, memberId },
    update: {},
  });
}
