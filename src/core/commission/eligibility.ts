import { meetsThreshold, readTokenBalance } from '../wallet/balance.js';
import type { BalanceOutcome } from '../wallet/balance.js';

/**
 * Whether a member may order a commission right now.
 *
 * Three gates, and the order matters: the cheap local checks run before the
 * one that costs a network round trip, so a project with commissions switched
 * off never touches an RPC endpoint.
 *
 * Every refusal names what would fix it. "Not eligible" is a dead end; "you
 * hold 400 and need 1000" is something a member can act on, and not telling
 * them the threshold would leave them guessing at a number the project has
 * already published.
 */

export interface CommissionTerms {
  readonly enabled: boolean;
  readonly priceUsdcCents: number;
  /**
   * Not used by eligibility, and carried here anyway.
   *
   * Ordering copies price and share onto the order together, and the two have
   * to come from the same read — a share fetched separately is a share that
   * can be fetched from different settings than the price it belongs to.
   */
  readonly treasuryShareBps: number;
  readonly monthlyCapacity: number;
  readonly eligibleSlots: readonly string[];
  readonly tokenMint: string | null;
  readonly tokenMinimum: string | null;
}

export type EligibilityRefusal =
  | { readonly kind: 'disabled' }
  /** No slot is open for customisation, so there is nothing to order. */
  | { readonly kind: 'no-eligible-slots' }
  /** This month is full. Names when it reopens. */
  | { readonly kind: 'at-capacity'; readonly capacity: number; readonly reopensAt: Date }
  /** The member already has one in flight. */
  | { readonly kind: 'already-ordered' }
  /** A wallet is required and none is linked. */
  | { readonly kind: 'wallet-required'; readonly minimum: string; readonly mint: string }
  /** Linked, but short. Says by how much. */
  | {
      readonly kind: 'below-threshold';
      readonly minimum: string;
      readonly held: string;
      readonly mint: string;
    }
  /** The holding could not be established. Fails closed. */
  | { readonly kind: 'holding-unverifiable' };

export type EligibilityOutcome =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'refused'; readonly refusal: EligibilityRefusal };

export interface EligibilityInput {
  readonly terms: CommissionTerms;
  /** Commissions already accepted this calendar month. */
  readonly acceptedThisMonth: number;
  /** Whether this member already holds a live order here. */
  readonly hasOpenOrder: boolean;
  /** The member's proved wallet address, if any. */
  readonly walletAddress: string | null;
  readonly now: Date;
  /** Reads a balance. Injected so this stays testable without a network. */
  readonly readBalance?: (owner: string, mint: string) => Promise<BalanceOutcome>;
}

/** First moment of the next calendar month, in UTC. */
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** First moment of the current calendar month, in UTC. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Renders a raw balance in the human units a threshold is written in, so a
 * refusal can say how far short somebody is rather than only that they are.
 */
function humanAmount(raw: bigint, decimals: number): string {
  if (decimals === 0) {
    return raw.toString();
  }
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

export async function checkEligibility(input: EligibilityInput): Promise<EligibilityOutcome> {
  const { terms } = input;

  if (!terms.enabled) {
    return { kind: 'refused', refusal: { kind: 'disabled' } };
  }

  if (terms.eligibleSlots.length === 0) {
    return { kind: 'refused', refusal: { kind: 'no-eligible-slots' } };
  }

  // Checked before capacity: a member who already has one in flight should be
  // told that, not told the month is full.
  if (input.hasOpenOrder) {
    return { kind: 'refused', refusal: { kind: 'already-ordered' } };
  }

  if (terms.monthlyCapacity <= 0 || input.acceptedThisMonth >= terms.monthlyCapacity) {
    return {
      kind: 'refused',
      refusal: {
        kind: 'at-capacity',
        capacity: Math.max(0, terms.monthlyCapacity),
        reopensAt: nextMonthStart(input.now),
      },
    };
  }

  // No token gate configured. Both halves or neither, checked here rather than
  // trusting settings: half a gate configured by accident must not become a
  // gate that lets everybody through while looking like it is working.
  const { tokenMint, tokenMinimum } = terms;
  if (tokenMint === null || tokenMinimum === null) {
    return { kind: 'eligible' };
  }

  if (input.walletAddress === null) {
    return {
      kind: 'refused',
      refusal: { kind: 'wallet-required', minimum: tokenMinimum, mint: tokenMint },
    };
  }

  const read = input.readBalance;
  if (read === undefined) {
    // No way to check means no way to grant. Fail closed.
    return { kind: 'refused', refusal: { kind: 'holding-unverifiable' } };
  }

  const outcome = await read(input.walletAddress, tokenMint);

  // Anything that is not a definite reading is a refusal, and a distinct one:
  // telling somebody they are short when the truth is the endpoint was down
  // would send them buying tokens they may already hold.
  if (outcome.kind !== 'read') {
    return { kind: 'refused', refusal: { kind: 'holding-unverifiable' } };
  }

  if (!meetsThreshold(outcome, tokenMinimum)) {
    return {
      kind: 'refused',
      refusal: {
        kind: 'below-threshold',
        minimum: tokenMinimum,
        held: humanAmount(outcome.balance.raw, outcome.balance.decimals),
        mint: tokenMint,
      },
    };
  }

  return { kind: 'eligible' };
}

/** Builds the balance reader eligibility needs from an RPC endpoint. */
export function balanceReaderFor(
  rpcUrl: string,
): (owner: string, mint: string) => Promise<BalanceOutcome> {
  return (owner, mint) => readTokenBalance({ rpcUrl, owner, mint });
}
