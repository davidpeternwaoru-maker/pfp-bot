import { describe, expect, it } from 'vitest';
import {
  decideEligibility,
  parseEligibilityRule,
  ruleGroupId,
} from '../../src/core/eligibility/rule.js';
import type { MembershipFact } from '../../src/core/eligibility/rule.js';

/**
 * Who may roll.
 *
 * One property decides this file: nothing that is not a definite yes may be a
 * yes. A gate that opens when a check fails is a gate that opens exactly when
 * something is wrong, so every ambiguous path is enumerated and every one of
 * them refuses.
 */

const NOW = new Date('2026-08-25T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

const MEMBER = (knownSince: Date | null): MembershipFact => ({ kind: 'member', knownSince });
const NOT_MEMBER: MembershipFact = { kind: 'not-member' };
const UNKNOWN: MembershipFact = { kind: 'unknown' };

describe('reading a stored rule', () => {
  it('treats an absent or empty rule as open to all', () => {
    // The column defaults to {}, and most projects gate on nothing.
    expect(parseEligibilityRule({})).toEqual({ kind: 'open' });
    expect(parseEligibilityRule(null)).toEqual({ kind: 'open' });
    expect(parseEligibilityRule(undefined)).toEqual({ kind: 'open' });
    expect(parseEligibilityRule({ kind: 'open' })).toEqual({ kind: 'open' });
  });

  it('reads the two group rules', () => {
    expect(parseEligibilityRule({ kind: 'group-member', groupId: '-100123' })).toEqual({
      kind: 'group-member',
      groupId: '-100123',
    });
    expect(
      parseEligibilityRule({ kind: 'group-tenure', groupId: '-100123', minimumDays: 30 }),
    ).toEqual({ kind: 'group-tenure', groupId: '-100123', minimumDays: 30 });
  });

  it('refuses to read a rule it does not understand, rather than defaulting to open', () => {
    // A project that said something about who may enter and was misunderstood
    // must not quietly admit everybody. Null here means refuse.
    for (const bad of [
      { kind: 'group-member' }, // no group
      { kind: 'group-member', groupId: '' },
      { kind: 'group-tenure', groupId: '-1' }, // no minimum
      { kind: 'group-tenure', groupId: '-1', minimumDays: -5 },
      { kind: 'group-tenure', groupId: '-1', minimumDays: 1.5 },
      { kind: 'group-tenure', groupId: '-1', minimumDays: 99_999 },
      { kind: 'token-holding' }, // a rule this file does not implement
      { kind: 'open-to-all' }, // nearly right, and not right
      'open',
      42,
    ]) {
      expect(parseEligibilityRule(bad)).toBeNull();
    }
  });

  it('names the group a rule refers to, and none for an open one', () => {
    expect(ruleGroupId({ kind: 'open' })).toBeNull();
    expect(ruleGroupId(null)).toBeNull();
    expect(ruleGroupId({ kind: 'group-member', groupId: '-100' })).toBe('-100');
  });
});

describe('open to all', () => {
  it('lets anybody through without asking anything', () => {
    // Not even an unknown membership matters: nothing was asked, so nothing
    // can fail to be established.
    for (const fact of [MEMBER(null), NOT_MEMBER, UNKNOWN]) {
      expect(decideEligibility({ kind: 'open' }, fact, NOW)).toEqual({ kind: 'eligible' });
    }
  });
});

describe('current group membership', () => {
  const rule = { kind: 'group-member', groupId: '-100123' } as const;

  it('lets a member through', () => {
    expect(decideEligibility(rule, MEMBER(null), NOW)).toEqual({ kind: 'eligible' });
  });

  it('tells somebody outside which group to join', () => {
    const decision = decideEligibility(rule, NOT_MEMBER, NOW);

    expect(decision).toEqual({
      kind: 'refused',
      refusal: { kind: 'must-join', groupId: '-100123' },
    });
  });

  it('refuses when it could not check, and says so distinctly', () => {
    // Not the same refusal as "you are not in the group". Collapsing the two
    // would send somebody off to join a group they are already in.
    const decision = decideEligibility(rule, UNKNOWN, NOW);

    expect(decision).toMatchObject({ refusal: { kind: 'unverifiable' } });
  });
});

describe('minimum group tenure', () => {
  const rule = { kind: 'group-tenure', groupId: '-100123', minimumDays: 30 } as const;

  it('lets somebody through once they have been known long enough', () => {
    expect(decideEligibility(rule, MEMBER(daysAgo(30)), NOW)).toEqual({ kind: 'eligible' });
    expect(decideEligibility(rule, MEMBER(daysAgo(400)), NOW)).toEqual({ kind: 'eligible' });
  });

  it('says how long they have and when they qualify', () => {
    const decision = decideEligibility(rule, MEMBER(daysAgo(10)), NOW);

    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused' && decision.refusal.kind === 'too-new') {
      // A bare refusal is a dead end; a date is something to come back on.
      expect(decision.refusal.heldDays).toBe(10);
      expect(decision.refusal.minimumDays).toBe(30);
      expect(decision.refusal.eligibleAt).toEqual(new Date('2026-09-14T12:00:00.000Z'));
    } else {
      throw new Error('expected a too-new refusal');
    }
  });

  it('refuses the day before and admits on the day', () => {
    expect(decideEligibility(rule, MEMBER(daysAgo(29)), NOW).kind).toBe('refused');
    expect(decideEligibility(rule, MEMBER(daysAgo(30)), NOW).kind).toBe('eligible');
  });

  it('refuses somebody in the group with nothing to measure from', () => {
    // A project asking for thirty days did not mean "or none at all".
    const decision = decideEligibility(rule, MEMBER(null), NOW);

    expect(decision).toMatchObject({ refusal: { kind: 'unverifiable' } });
  });

  it('sends somebody outside the group to join it, not to wait', () => {
    expect(decideEligibility(rule, NOT_MEMBER, NOW)).toMatchObject({
      refusal: { kind: 'must-join' },
    });
  });

  it('treats a zero-day minimum as membership alone', () => {
    const instant = { kind: 'group-tenure', groupId: '-1', minimumDays: 0 } as const;
    expect(decideEligibility(instant, MEMBER(NOW), NOW)).toEqual({ kind: 'eligible' });
  });
});

describe('failing closed', () => {
  it('refuses every ambiguous case, enumerated', () => {
    const gated = [
      { kind: 'group-member', groupId: '-1' },
      { kind: 'group-tenure', groupId: '-1', minimumDays: 7 },
    ] as const;

    // The whole matrix of "we could not establish it" against every gated
    // rule. Not one of these may be eligible.
    for (const rule of gated) {
      expect(decideEligibility(rule, UNKNOWN, NOW).kind).toBe('refused');
      expect(decideEligibility(null, UNKNOWN, NOW).kind).toBe('refused');
      expect(decideEligibility(null, MEMBER(daysAgo(999)), NOW).kind).toBe('refused');
    }
  });

  it('refuses an unreadable rule even for somebody who would otherwise pass', () => {
    // The strongest form of the property: a long-standing member of the right
    // group is still refused when the rule itself cannot be read.
    const decision = decideEligibility(null, MEMBER(daysAgo(1000)), NOW);
    expect(decision).toEqual({ kind: 'refused', refusal: { kind: 'unverifiable' } });
  });
});
