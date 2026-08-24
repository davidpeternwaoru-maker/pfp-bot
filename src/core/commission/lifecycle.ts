import { isTerminal } from './types.js';
import type { CommissionStatus } from './types.js';

/**
 * Which moves a commission is allowed to make.
 *
 * Written as a table rather than as conditions scattered across handlers,
 * because the one thing this phase must guarantee is that nothing reaches
 * production without an explicit approval. A rule spread over six call sites
 * is a rule with six chances to be forgotten; a rule in one table is a rule
 * you can read in ten seconds and a test can enumerate exhaustively.
 *
 * Pure, and deliberately ignorant of who is asking. Authorisation is a
 * separate question answered by the caller — this only says whether the move
 * exists at all.
 */

/**
 * Every legal transition, as from → to.
 *
 * Note what is absent. There is no route from awaiting_payment or
 * awaiting_approval to in_production, so an unapproved commission cannot be
 * produced by any sequence of moves. Nothing leaves a terminal state either:
 * a delivered commission stays delivered, and a decline cannot be quietly
 * reversed into an approval after the member has been told.
 */
const TRANSITIONS: Readonly<Record<CommissionStatus, readonly CommissionStatus[]>> = {
  // Paying moves it into the queue. Withdrawing costs nothing, because
  // nothing has been paid.
  awaiting_payment: ['awaiting_approval', 'cancelled'],
  // The gate. Approval and decline are the only ways out, and both are a
  // deliberate operator act.
  awaiting_approval: ['approved', 'declined'],
  // Approved work can still be refused once an illustrator looks properly at
  // what was asked for — better a refund than a piece that cannot be made.
  approved: ['in_production', 'declined'],
  // Work has started. Declining here is rare and costly, and still allowed:
  // discovering mid-draw that a brief is unproducible must not force delivery.
  in_production: ['delivered', 'declined'],
  delivered: [],
  declined: [],
  cancelled: [],
};

export function allowedNext(status: CommissionStatus): readonly CommissionStatus[] {
  return TRANSITIONS[status];
}

export function canTransition(from: CommissionStatus, to: CommissionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Whether a commission occupies its member's one live-order slot.
 *
 * The same question as "is this not terminal", named for what it decides. A
 * member may hold one live order per project; finished ones stop competing
 * for that slot without being deleted, which is what lets the history survive.
 */
export function occupiesOrderSlot(status: CommissionStatus): boolean {
  return !isTerminal(status);
}

/**
 * Whether this commission owes the member money back.
 *
 * A decline after payment owes a refund. A cancellation does not, because
 * cancelling is only possible before paying — that is why the state machine
 * has no route from awaiting_approval to cancelled.
 */
export function owesRefund(status: CommissionStatus, paidAt: Date | null): boolean {
  return status === 'declined' && paidAt !== null;
}

/**
 * The treasury's share of one commission, in USDC cents.
 *
 * Integer arithmetic throughout, and floored rather than rounded. A payable
 * report that rounded up would, across enough orders, promise a project more
 * than was ever collected — and a shortfall discovered at payout time is the
 * worst possible moment to find an accounting bug.
 */
export function treasuryShareCents(priceUsdcCents: number, treasuryShareBps: number): number {
  if (!Number.isSafeInteger(priceUsdcCents) || priceUsdcCents < 0) {
    return 0;
  }
  if (!Number.isSafeInteger(treasuryShareBps) || treasuryShareBps <= 0) {
    return 0;
  }
  // Capped at the whole price: a misconfigured share above 100% must not
  // generate a payable larger than the money that came in.
  const bps = Math.min(treasuryShareBps, 10_000);
  return Math.floor((priceUsdcCents * bps) / 10_000);
}

/** Formats USDC cents the way an operator reading a report expects. */
export function formatUsdc(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `${String(whole)}.${String(remainder).padStart(2, '0')} USDC`;
}
