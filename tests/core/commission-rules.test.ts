import { describe, expect, it } from 'vitest';
import {
  MAX_NOTE_LENGTH,
  MAX_TEXT_LENGTH,
  validateBrief,
} from '../../src/core/commission/brief.js';
import {
  allowedNext,
  canTransition,
  formatUsdc,
  occupiesOrderSlot,
  owesRefund,
  treasuryShareCents,
} from '../../src/core/commission/lifecycle.js';
import { checkEligibility, nextMonthStart } from '../../src/core/commission/eligibility.js';
import type { CommissionTerms } from '../../src/core/commission/eligibility.js';
import { COMMISSION_STATUSES, isTerminal } from '../../src/core/commission/types.js';
import type { CommissionStatus } from '../../src/core/commission/types.js';
import type { BalanceOutcome } from '../../src/core/wallet/balance.js';

/**
 * The rules a commission obeys before any of it touches a database.
 *
 * One of them carries the phase: nothing reaches production without an
 * explicit approval. That is a property of the transition table, so it is
 * tested by enumerating the table rather than by exercising a happy path and
 * hoping the unhappy ones were considered.
 */

const SLOTS = ['hat', 'eyes'] as const;

const TERMS: CommissionTerms = {
  enabled: true,
  priceUsdcCents: 5_000,
  treasuryShareBps: 1_250,
  monthlyCapacity: 10,
  eligibleSlots: SLOTS,
  tokenMint: null,
  tokenMinimum: null,
};

const NOW = new Date('2026-08-24T12:00:00.000Z');

function eligibility(overrides: Partial<Parameters<typeof checkEligibility>[0]> = {}) {
  return checkEligibility({
    terms: TERMS,
    acceptedThisMonth: 0,
    hasOpenOrder: false,
    walletAddress: null,
    now: NOW,
    ...overrides,
  });
}

function balance(raw: bigint, decimals: number): BalanceOutcome {
  return { kind: 'read', balance: { raw, decimals } };
}

describe('the approval gate', () => {
  it('has no route to production that does not pass through approval', () => {
    // Enumerated rather than sampled. Every state, every move: production is
    // reachable only from approved, and that is the whole promise of the gate.
    for (const from of COMMISSION_STATUSES) {
      for (const to of COMMISSION_STATUSES) {
        if (to === 'in_production' && canTransition(from, to)) {
          expect(from).toBe('approved');
        }
      }
    }

    expect(canTransition('awaiting_payment', 'in_production')).toBe(false);
    expect(canTransition('awaiting_approval', 'in_production')).toBe(false);
    expect(canTransition('awaiting_approval', 'delivered')).toBe(false);
  });

  it('cannot deliver anything that was never produced', () => {
    for (const from of COMMISSION_STATUSES) {
      if (canTransition(from, 'delivered')) {
        expect(from).toBe('in_production');
      }
    }
  });

  it('lets nothing leave a terminal state', () => {
    // A decline must not be quietly reversed after the member has been told,
    // and a delivered claim is permanent by the same rules as any other.
    for (const status of COMMISSION_STATUSES) {
      if (isTerminal(status)) {
        expect(allowedNext(status)).toEqual([]);
      }
    }
  });

  it('can refuse at every stage before delivery', () => {
    // Discovering mid-draw that a brief is unproducible must not force
    // delivery of something that cannot be made.
    for (const from of ['awaiting_approval', 'approved', 'in_production'] as const) {
      expect(canTransition(from, 'declined')).toBe(true);
    }
  });

  it('only lets an unpaid order be cancelled', () => {
    // Cancelling after payment would owe a refund while claiming not to,
    // which is why the refund rule can key on decline alone.
    for (const from of COMMISSION_STATUSES) {
      if (canTransition(from, 'cancelled')) {
        expect(from).toBe('awaiting_payment');
      }
    }
  });

  it('frees the member order slot exactly when the order is finished', () => {
    for (const status of COMMISSION_STATUSES) {
      expect(occupiesOrderSlot(status)).toBe(!isTerminal(status));
    }
  });
});

describe('what is owed', () => {
  it('owes a refund on a decline that was paid for, and only then', () => {
    const paid = new Date();

    expect(owesRefund('declined', paid)).toBe(true);
    expect(owesRefund('declined', null)).toBe(false);
    expect(owesRefund('cancelled', null)).toBe(false);
    expect(owesRefund('delivered', paid)).toBe(false);
  });

  it('computes the treasury share as exact integer cents', () => {
    // 12.5% of 50.00 USDC.
    expect(treasuryShareCents(5_000, 1_250)).toBe(625);
    expect(treasuryShareCents(5_000, 10_000)).toBe(5_000);
    expect(treasuryShareCents(5_000, 0)).toBe(0);
  });

  it('floors rather than rounds, so a report never promises uncollected money', () => {
    // 33.33% of 10.00 USDC is 3.333 cents short of a clean number. Rounding up
    // across enough orders promises a project more than ever came in.
    expect(treasuryShareCents(1_000, 3_333)).toBe(333);
    expect(treasuryShareCents(1, 5_000)).toBe(0);
  });

  it('never generates a payable larger than the money that came in', () => {
    // A misconfigured share above 100% is an operator error, and the safe
    // reading of it is "all of it", never "more than all of it".
    expect(treasuryShareCents(5_000, 50_000)).toBe(5_000);
    expect(treasuryShareCents(5_000, -100)).toBe(0);
  });

  it('formats cents the way an operator reads them', () => {
    expect(formatUsdc(5_000)).toBe('50.00 USDC');
    expect(formatUsdc(625)).toBe('6.25 USDC');
    expect(formatUsdc(5)).toBe('0.05 USDC');
    expect(formatUsdc(0)).toBe('0.00 USDC');
  });
});

describe('the brief', () => {
  it('accepts a complete, sensible brief', () => {
    const result = validateBrief(
      { slot: 'hat', textContent: 'DAVID', colour: 'gold', note: 'Slightly tilted, please.' },
      SLOTS,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brief.textContent).toBe('DAVID');
      expect(result.brief.colour).toBe('gold');
    }
  });

  it('treats blank and whitespace-only answers as absent', () => {
    // Storing "   " would put whitespace in front of an illustrator as though
    // it were an instruction.
    const result = validateBrief({ slot: 'hat', textContent: '  ', note: '' }, SLOTS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brief.textContent).toBeNull();
      expect(result.brief.note).toBeNull();
    }
  });

  it('reports every problem at once, not one at a time', () => {
    const result = validateBrief(
      {
        slot: 'nose',
        textContent: 'x'.repeat(MAX_TEXT_LENGTH + 1),
        colour: 'burnt sienna',
        note: 'y'.repeat(MAX_NOTE_LENGTH + 1),
      },
      SLOTS,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A member fixing one field and being told about the next is the
      // drip-feed that makes a form hateful.
      expect(result.problems.map((problem) => problem.field).sort()).toEqual([
        'colour',
        'note',
        'slot',
        'textContent',
      ]);
    }
  });

  it('names the fix in every problem, never just the fault', () => {
    const result = validateBrief({ slot: 'nose', colour: 'octarine' }, SLOTS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const problem of result.problems) {
        expect(problem.message.length).toBeGreaterThan(10);
      }
      // The slot problem lists what to choose instead of what was wrong.
      const slot = result.problems.find((problem) => problem.field === 'slot');
      expect(slot?.message).toContain('hat');
      expect(slot?.message).toContain('eyes');
    }
  });

  it('says the actual length when text is too long', () => {
    const result = validateBrief({ slot: 'hat', textContent: 'x'.repeat(30) }, SLOTS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.message).toContain('30');
      expect(result.problems[0]?.message).toContain(String(MAX_TEXT_LENGTH));
    }
  });

  it('refuses characters that would render differently to approver and illustrator', () => {
    // Zero-width joiners, bidi overrides and control characters all display as
    // nothing, or as something other than what they are, in an approval queue.
    for (const hostile of ['A‍B', 'A‮B', 'A B', 'emoji 🎩', 'line\nbreak']) {
      const result = validateBrief({ slot: 'hat', textContent: hostile }, SLOTS);
      expect(result.ok).toBe(false);
    }
  });

  it('refuses a slot the project has not opened for commissions', () => {
    const result = validateBrief({ slot: 'background' }, SLOTS);
    expect(result.ok).toBe(false);
  });

  it('says so plainly when no slot is open at all', () => {
    const result = validateBrief({ slot: 'hat' }, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.message).toContain('not taking commissions');
    }
  });
});

describe('eligibility', () => {
  it('lets an ordinary member through when no token gate is set', async () => {
    expect(await eligibility()).toEqual({ kind: 'eligible' });
  });

  it('refuses when the project has commissions switched off', async () => {
    const outcome = await eligibility({ terms: { ...TERMS, enabled: false } });
    expect(outcome).toMatchObject({ refusal: { kind: 'disabled' } });
  });

  it('refuses a member who already has one in flight, before mentioning capacity', async () => {
    // Being told the month is full when the real reason is your own open order
    // sends somebody back next month to hit the same wall.
    const outcome = await eligibility({ hasOpenOrder: true, acceptedThisMonth: 999 });
    expect(outcome).toMatchObject({ refusal: { kind: 'already-ordered' } });
  });

  it('refuses at capacity and says when it reopens', async () => {
    const outcome = await eligibility({ acceptedThisMonth: 10 });

    expect(outcome).toMatchObject({ refusal: { kind: 'at-capacity', capacity: 10 } });
    if (outcome.kind === 'refused' && outcome.refusal.kind === 'at-capacity') {
      expect(outcome.refusal.reopensAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    }
  });

  it('treats a capacity of zero as closed rather than unlimited', async () => {
    // The default is zero, and reading that as "no limit" would open every
    // project that never configured one.
    const outcome = await eligibility({ terms: { ...TERMS, monthlyCapacity: 0 } });
    expect(outcome).toMatchObject({ refusal: { kind: 'at-capacity' } });
  });

  it('rolls the reopening date over a year end', () => {
    expect(nextMonthStart(new Date('2026-12-14T09:00:00.000Z'))).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });
});

describe('the token gate', () => {
  const GATED: CommissionTerms = {
    ...TERMS,
    tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tokenMinimum: '1000',
  };

  it('requires a linked wallet, and names the threshold rather than hiding it', async () => {
    const outcome = await eligibility({ terms: GATED, walletAddress: null });

    expect(outcome).toMatchObject({ refusal: { kind: 'wallet-required', minimum: '1000' } });
  });

  it('lets a holder through', async () => {
    const outcome = await eligibility({
      terms: GATED,
      walletAddress: 'owner',
      readBalance: () => Promise.resolve(balance(1_000_000_000n, 6)),
    });

    expect(outcome).toEqual({ kind: 'eligible' });
  });

  it('says how far short somebody is, not merely that they are', async () => {
    const outcome = await eligibility({
      terms: GATED,
      walletAddress: 'owner',
      readBalance: () => Promise.resolve(balance(400_000_000n, 6)),
    });

    expect(outcome).toMatchObject({
      refusal: { kind: 'below-threshold', minimum: '1000', held: '400' },
    });
  });

  it('reports a fractional holding readably', async () => {
    const outcome = await eligibility({
      terms: GATED,
      walletAddress: 'owner',
      readBalance: () => Promise.resolve(balance(999_500_000n, 6)),
    });

    if (outcome.kind === 'refused' && outcome.refusal.kind === 'below-threshold') {
      expect(outcome.refusal.held).toBe('999.5');
    } else {
      throw new Error('expected a below-threshold refusal');
    }
  });

  it('fails closed when the holding cannot be established', async () => {
    // Distinct from below-threshold on purpose: telling somebody they are
    // short when the endpoint was down sends them buying what they may hold.
    const outcome = await eligibility({
      terms: GATED,
      walletAddress: 'owner',
      readBalance: () => Promise.resolve({ kind: 'unavailable', reason: 'rpc timed out' }),
    });

    expect(outcome).toMatchObject({ refusal: { kind: 'holding-unverifiable' } });
  });

  it('fails closed when there is no way to check at all', async () => {
    const outcome = await eligibility({ terms: GATED, walletAddress: 'owner' });
    expect(outcome).toMatchObject({ refusal: { kind: 'holding-unverifiable' } });
  });

  it('ignores half a gate rather than enforcing it wrongly', async () => {
    // A mint with no threshold gates on nothing. Reading it as "any holding
    // will do" would be a gate that looks configured and admits everybody.
    const halfGated: CommissionTerms = { ...TERMS, tokenMint: 'mint', tokenMinimum: null };
    expect(await eligibility({ terms: halfGated, walletAddress: null })).toEqual({
      kind: 'eligible',
    });
  });

  it('never reaches the network when a cheaper check already refused', async () => {
    let called = false;
    await eligibility({
      terms: { ...GATED, enabled: false },
      walletAddress: 'owner',
      readBalance: () => {
        called = true;
        return Promise.resolve(balance(0n, 6));
      },
    });

    expect(called).toBe(false);
  });
});

describe('the status vocabulary', () => {
  it('agrees with the transition table about which states are terminal', () => {
    const terminal = COMMISSION_STATUSES.filter((status: CommissionStatus) => isTerminal(status));
    expect([...terminal].sort()).toEqual(['cancelled', 'declined', 'delivered']);
  });
});
