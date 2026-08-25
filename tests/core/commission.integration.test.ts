import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../src/core/db/client.js';
import {
  addRevision,
  placeOrder,
  transitionCommission,
} from '../../src/core/commission/order-service.js';
import {
  countAcceptedThisMonth,
  findCommission,
  findOpenCommission,
  findOperatorQueue,
  joinWaitlist,
  payablesReport,
} from '../../src/core/db/commission-repository.js';
import type { ValidBrief } from '../../src/core/commission/brief.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { assertDatabaseResponsive } from '../helpers/database.js';

/**
 * Commissions against real PostgreSQL.
 *
 * Two of this phase's promises are database promises and cannot be tested
 * against a fake. Capacity has to hold when orders arrive together, and a
 * queue entry has to survive two operators acting on it at once. A stub would
 * agree with whatever the code believed; only Postgres can refuse the second.
 */

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
const DATABASE_URL = process.env['DATABASE_URL'];

let prisma: PrismaClient;
let projectId: number;
let memberIds: number[];
let nextExternalId = BigInt(Date.now()) * 1000n;

const PRICE_CENTS = 5_000;
const TREASURY_BPS = 1_250;

const BRIEF: ValidBrief = {
  slot: 'hat',
  textContent: 'DAVID',
  colour: 'gold',
  note: null,
  referencePath: null,
};

async function freshMember(): Promise<number> {
  nextExternalId += 1n;
  const member = await prisma.member.create({
    data: {
      platform: 'telegram',
      externalId: String(nextExternalId),
      handle: `commission_${String(nextExternalId)}`,
    },
    select: { id: true },
  });
  memberIds.push(member.id);
  return member.id;
}

async function order(memberId: number, capacity = 100) {
  return placeOrder({
    prisma,
    projectId,
    memberId,
    brief: BRIEF,
    priceUsdcCents: PRICE_CENTS,
    treasuryShareBps: TREASURY_BPS,
    monthlyCapacity: capacity,
  });
}

/** Walks an order all the way to delivered, the way the operator would. */
async function deliver(commissionId: number): Promise<void> {
  await transitionCommission({
    prisma,
    commissionId,
    from: 'awaiting_payment',
    to: 'awaiting_approval',
  });
  await transitionCommission({ prisma, commissionId, from: 'awaiting_approval', to: 'approved' });
  await transitionCommission({ prisma, commissionId, from: 'approved', to: 'in_production' });
  await transitionCommission({ prisma, commissionId, from: 'in_production', to: 'delivered' });
}

/**
 * Fixtures live at file level rather than inside the first suite.
 *
 * Nested describes do not inherit a sibling's hooks, so setup owned by one
 * suite leaves every later suite running against undefined — which fails as a
 * confusing TypeError rather than as the missing fixture it actually is.
 */
beforeAll(async () => {
  if (DATABASE_URL === undefined) {
    return;
  }
  prisma = createPrismaClient(DATABASE_URL);
  await assertDatabaseResponsive(prisma);

  memberIds = [];
  const project = await prisma.project.create({
    data: {
      name: 'Commission Fixture',
      slug: `commission-${String(Date.now())}`,
      mascotName: 'fixture',
      status: 'live',
      canvasWidth: 32,
      canvasHeight: 32,
    },
    select: { id: true },
  });
  projectId = project.id;
}, 120_000);

afterAll(async () => {
  if (prisma === undefined) {
    return;
  }
  if (projectId !== undefined) {
    await prisma.commissionWaitlist.deleteMany({ where: { projectId } });
    await prisma.commissionBrief.deleteMany({ where: { commission: { projectId } } });
    await prisma.commission.deleteMany({ where: { projectId } });
    await prisma.commissionSettings.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
  }
  if (memberIds !== undefined && memberIds.length > 0) {
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
  }
  await prisma.$disconnect();
}, 60_000);

describe.skipIf(DATABASE_URL === undefined)('commissions', () => {
  it('places an order with its brief in one go', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);

    expect(placed.kind).toBe('ordered');
    if (placed.kind !== 'ordered') {
      return;
    }

    const view = await findCommission(prisma, placed.commissionId);
    expect(view?.status).toBe('awaiting_payment');
    // A commission with no brief is an order nobody can produce.
    expect(view?.briefs).toHaveLength(1);
    expect(view?.briefs[0]?.slot).toBe('hat');
    expect(view?.briefs[0]?.revision).toBe(0);

    // Price and share are copied onto the order, not read live later.
    expect(view?.priceUsdcCents).toBe(PRICE_CENTS);
    expect(view?.treasuryShareBps).toBe(TREASURY_BPS);
  }, 60_000);

  it('refuses a second live order from the same member', async () => {
    const memberId = await freshMember();
    expect((await order(memberId)).kind).toBe('ordered');

    // Two open orders is one member holding two people's worth of a capacity
    // the project promised everybody.
    expect((await order(memberId)).kind).toBe('already-ordered');
    expect(await findOpenCommission(prisma, projectId, memberId)).not.toBeNull();
  }, 60_000);

  it('lets a member order again once the previous one is finished', async () => {
    const memberId = await freshMember();
    const first = await order(memberId);
    if (first.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }

    await deliver(first.commissionId);

    // The slot is released by reaching a terminal state, not by deletion, so
    // the history survives.
    expect(await findOpenCommission(prisma, projectId, memberId)).toBeNull();
    expect((await order(memberId)).kind).toBe('ordered');
  }, 60_000);

  it('holds capacity when orders arrive at the same instant', async () => {
    // The phase gate: "capacity limits hold under concurrent orders".
    //
    // Six rather than a bigger number on purpose. Every one of these queues on
    // the same project row lock, and the claim suite already opens twenty of
    // its own; stacking more onto a throttled database makes the pair time out
    // and report a flake where there is no fault. Twice the capacity is
    // already more than enough to lose the race if the lock were not there.
    const capacity = 3;
    const claimants = 6;
    const members = await Promise.all(Array.from({ length: claimants }, () => freshMember()));

    const before = await countAcceptedThisMonth(prisma, projectId);
    const outcomes = await Promise.all(
      members.map((memberId) => order(memberId, before + capacity)),
    );

    const ordered = outcomes.filter((outcome) => outcome.kind === 'ordered');
    const full = outcomes.filter((outcome) => outcome.kind === 'at-capacity');

    // Exactly the remaining capacity got through. Not four, not two.
    expect(ordered).toHaveLength(capacity);
    expect(full).toHaveLength(claimants - capacity);
    expect(await countAcceptedThisMonth(prisma, projectId)).toBe(before + capacity);
  }, 120_000);
});

describe.skipIf(DATABASE_URL === undefined)('the approval gate, against the database', () => {
  it('refuses to move a commission somebody else has already moved', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);
    if (placed.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }
    const commissionId = placed.commissionId;

    await transitionCommission({
      prisma,
      commissionId,
      from: 'awaiting_payment',
      to: 'awaiting_approval',
      paymentReference: 'tx-abc',
    });

    // Two operators on the same queue entry. One approves, one declines.
    const [approve, decline] = await Promise.all([
      transitionCommission({ prisma, commissionId, from: 'awaiting_approval', to: 'approved' }),
      transitionCommission({
        prisma,
        commissionId,
        from: 'awaiting_approval',
        to: 'declined',
        declineReason: 'prohibited_content',
      }),
    ]);

    const moved = [approve, decline].filter((outcome) => outcome.kind === 'moved');
    const stale = [approve, decline].filter((outcome) => outcome.kind === 'stale');

    // Exactly one wins, and the loser is told rather than silently overwriting
    // a decision the member may already have been notified about.
    expect(moved).toHaveLength(1);
    expect(stale).toHaveLength(1);
  }, 60_000);

  it('cannot reach production without passing through approval', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);
    if (placed.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }

    const jumped = await transitionCommission({
      prisma,
      commissionId: placed.commissionId,
      from: 'awaiting_payment',
      to: 'in_production',
    });

    expect(jumped.kind).toBe('illegal');
    expect((await findCommission(prisma, placed.commissionId))?.status).toBe('awaiting_payment');
  }, 60_000);

  it('will not reopen a decline', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);
    if (placed.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }
    const commissionId = placed.commissionId;

    await transitionCommission({
      prisma,
      commissionId,
      from: 'awaiting_payment',
      to: 'awaiting_approval',
    });
    await transitionCommission({
      prisma,
      commissionId,
      from: 'awaiting_approval',
      to: 'declined',
      declineReason: 'rival_branding',
    });

    // The member has already been told. Quietly turning that into an approval
    // would make the notification a lie after the fact.
    const reopened = await transitionCommission({
      prisma,
      commissionId,
      from: 'declined',
      to: 'approved',
    });

    expect(reopened.kind).toBe('illegal');
  }, 60_000);

  it('records the single revision and refuses a second', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);
    if (placed.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }
    const commissionId = placed.commissionId;

    await transitionCommission({
      prisma,
      commissionId,
      from: 'awaiting_payment',
      to: 'awaiting_approval',
    });
    await transitionCommission({ prisma, commissionId, from: 'awaiting_approval', to: 'approved' });

    const revised: ValidBrief = { ...BRIEF, textContent: 'DAVE', colour: 'silver' };
    expect((await addRevision(prisma, commissionId, revised)).kind).toBe('recorded');

    // The cap is load-bearing: unlimited revisions is how this turns into the
    // operator mediating a design argument.
    expect((await addRevision(prisma, commissionId, revised)).kind).toBe('already-revised');

    const view = await findCommission(prisma, commissionId);
    expect(view?.briefs).toHaveLength(2);
    // Newest first, so what should actually be produced is index 0.
    expect(view?.briefs[0]?.revision).toBe(1);
    expect(view?.briefs[0]?.textContent).toBe('DAVE');
  }, 60_000);

  it('refuses a revision before there is anything to revise', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);
    if (placed.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }

    const early = await addRevision(prisma, placed.commissionId, BRIEF);
    expect(early.kind).toBe('wrong-status');
  }, 60_000);
});

describe.skipIf(DATABASE_URL === undefined)('what the operator sees and is owed', () => {
  it('queues work oldest first, and drops it once finished', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);
    if (placed.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }
    const commissionId = placed.commissionId;

    // Unpaid orders are the operator's problem too: confirming that USDC
    // arrived is a tap only they can make, so an order left out of the queue
    // here would sit unpaid forever with nothing anywhere able to move it.
    let queue = await findOperatorQueue(prisma, projectId);
    expect(queue.some((entry) => entry.id === commissionId)).toBe(true);

    await transitionCommission({
      prisma,
      commissionId,
      from: 'awaiting_payment',
      to: 'awaiting_approval',
    });
    queue = await findOperatorQueue(prisma, projectId);
    expect(queue.some((entry) => entry.id === commissionId)).toBe(true);

    // Oldest first: a queue surfacing the newest leaves whoever waited
    // longest waiting longest.
    const times = queue.map((entry) => entry.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    await transitionCommission({ prisma, commissionId, from: 'awaiting_approval', to: 'approved' });
    await transitionCommission({ prisma, commissionId, from: 'approved', to: 'in_production' });
    await transitionCommission({ prisma, commissionId, from: 'in_production', to: 'delivered' });

    queue = await findOperatorQueue(prisma, projectId);
    expect(queue.some((entry) => entry.id === commissionId)).toBe(false);
  }, 60_000);

  it('owes the treasury its share of delivered work', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);
    if (placed.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }

    const before = await payablesReport(prisma, projectId);
    await deliver(placed.commissionId);
    const after = await payablesReport(prisma, projectId);

    // 12.5% of 50.00 USDC.
    expect(after.treasuryOwedCents - before.treasuryOwedCents).toBe(625);
    const line = after.lines.find((entry) => entry.commissionId === placed.commissionId);
    expect(line?.kind).toBe('treasury-share');
    expect(line?.amount).toBe('6.25 USDC');
  }, 60_000);

  it('owes the member their money back on a decline they paid for', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);
    if (placed.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }
    const commissionId = placed.commissionId;

    const before = await payablesReport(prisma, projectId);
    await transitionCommission({
      prisma,
      commissionId,
      from: 'awaiting_payment',
      to: 'awaiting_approval',
    });
    await transitionCommission({
      prisma,
      commissionId,
      from: 'awaiting_approval',
      to: 'declined',
      declineReason: 'copyrighted_material',
    });
    const after = await payablesReport(prisma, projectId);

    // The whole price. A decline is the project's decision, so the member
    // carries none of its cost.
    expect(after.refundsOwedCents - before.refundsOwedCents).toBe(PRICE_CENTS);
    const line = after.lines.find((entry) => entry.commissionId === commissionId);
    expect(line?.kind).toBe('member-refund');
  }, 60_000);

  it('owes nothing for an order withdrawn before payment', async () => {
    const memberId = await freshMember();
    const placed = await order(memberId);
    if (placed.kind !== 'ordered') {
      throw new Error('fixture could not place an order');
    }

    const before = await payablesReport(prisma, projectId);
    await transitionCommission({
      prisma,
      commissionId: placed.commissionId,
      from: 'awaiting_payment',
      to: 'cancelled',
    });
    const after = await payablesReport(prisma, projectId);

    expect(after.refundsOwedCents).toBe(before.refundsOwedCents);
    expect(after.treasuryOwedCents).toBe(before.treasuryOwedCents);
  }, 60_000);

  it('never nets a refund against a share', async () => {
    // Different debts to different people. One combined figure would hide one
    // behind the other, and the two are settled separately.
    const report = await payablesReport(prisma, projectId);

    const refunds = report.lines
      .filter((line) => line.kind === 'member-refund')
      .reduce((total, line) => total + line.amountCents, 0);
    const treasury = report.lines
      .filter((line) => line.kind === 'treasury-share')
      .reduce((total, line) => total + line.amountCents, 0);

    expect(refunds).toBe(report.refundsOwedCents);
    expect(treasury).toBe(report.treasuryOwedCents);
  }, 60_000);

  it('takes somebody onto the waitlist once, however many times they ask', async () => {
    const memberId = await freshMember();

    await joinWaitlist(prisma, projectId, memberId);
    await joinWaitlist(prisma, projectId, memberId);

    // Moving somebody to the back of the queue for asking twice would punish
    // enthusiasm.
    const waiting = await prisma.commissionWaitlist.count({ where: { projectId, memberId } });
    expect(waiting).toBe(1);
  }, 60_000);
});
