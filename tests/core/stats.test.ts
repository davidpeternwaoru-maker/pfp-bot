import { describe, expect, it } from 'vitest';
import { projectStats } from '../../src/core/stats.js';
import type { StatsClaim } from '../../src/core/stats.js';
import { buildTraitPack } from '../../src/core/render/pack.js';
import { publishedFigures } from '../helpers/fixtures.js';
import type { TraitPack } from '../../src/core/render/types.js';

/**
 * The promise this file protects: a commission cannot move a published number.
 *
 * A project tells its holders how scarce their traits are. If a member could
 * order a private piece and shift that figure, the scarcity would change
 * underneath everyone who was told it — invisibly, because nobody else's
 * artwork changed. So the test is not "custom claims are handled correctly",
 * it is the stronger statement that adding any number of them leaves every
 * counted figure byte-for-byte identical.
 */

const CANVAS = { width: 8, height: 8 } as const;

function pack(): TraitPack {
  return buildTraitPack({
    projectId: 1,
    canvas: CANVAS,
    traits: [
      {
        id: 1,
        slot: 'body',
        name: 'plain',
        layerOrder: 10,
        imagePath: 'a.png',
        rarityWeight: 1,
        tier: 'open',
      },
      {
        id: 2,
        slot: 'body',
        name: 'gold',
        layerOrder: 10,
        imagePath: 'b.png',
        rarityWeight: 1,
        tier: 'legendary',
      },
      {
        id: 3,
        slot: 'hat',
        name: 'cap',
        layerOrder: 20,
        imagePath: 'c.png',
        rarityWeight: 1,
        tier: 'open',
      },
      {
        id: 4,
        slot: 'hat',
        name: 'none',
        layerOrder: 20,
        imagePath: 'd.png',
        rarityWeight: 1,
        tier: 'open',
      },
    ],
    exclusions: [],
  });
}

function at(minute: number): Date {
  return new Date(Date.UTC(2026, 7, 23, 12, minute));
}

/** Three rolled claims and one awarded legendary. The published picture. */
const PUBLISHED: readonly StatsClaim[] = [
  { traitIds: [1, 3], claimType: 'open', tier: 'open', claimedAt: at(1) },
  { traitIds: [1, 4], claimType: 'open', tier: 'open', claimedAt: at(2) },
  { traitIds: [1, 3], claimType: 'open', tier: 'open', claimedAt: at(3) },
  { traitIds: [2, 3], claimType: 'open', tier: 'legendary', claimedAt: at(4) },
];

/** Commissions, arriving later and in quantity. */
const COMMISSIONS: readonly StatsClaim[] = [
  { traitIds: [], claimType: 'custom', tier: 'legendary', claimedAt: at(50) },
  { traitIds: [], claimType: 'custom', tier: 'legendary', claimedAt: at(51) },
  { traitIds: [], claimType: 'custom', tier: 'legendary', claimedAt: at(52) },
];

describe('projectStats', () => {
  it('reports what was actually claimed', () => {
    const stats = projectStats(PUBLISHED, pack());

    expect(stats.countedClaims).toBe(4);
    expect(stats.rolledClaims).toBe(3);
    expect(stats.awardedClaims).toBe(1);
    expect(stats.customClaims).toBe(0);
    expect(stats.latestClaimAt).toEqual(at(4));

    // Rarest first: gold and none appear once, cap three times, plain three.
    expect(stats.traitHoldings.map((holding) => [holding.trait.name, holding.count])).toEqual([
      ['gold', 1],
      ['none', 1],
      ['plain', 3],
      ['cap', 3],
    ]);
    expect(stats.traitHoldings[0]?.share).toBeCloseTo(0.25);
  });

  it('does not move a single published number when commissions are added', () => {
    const before = projectStats(PUBLISHED, pack());
    const after = projectStats([...PUBLISHED, ...COMMISSIONS], pack());

    // Compared whole rather than field by field, so a figure added to this
    // report in a later phase is covered by this test the day it is added.
    expect(publishedFigures(after)).toEqual(publishedFigures(before));
    expect(after.customClaims).toBe(3);
  });

  it('counts bespoke claims, which dilute trait shares as they should', () => {
    const bespoke: StatsClaim = {
      traitIds: [],
      claimType: 'bespoke',
      tier: 'legendary',
      claimedAt: at(60),
    };
    const stats = projectStats([...PUBLISHED, bespoke], pack());

    // The project paid for it as part of the drop and it is transferable, so
    // it is part of supply: five claims now, and "plain" is 3 of 5, not 3 of 4.
    expect(stats.countedClaims).toBe(5);
    expect(stats.awardedClaims).toBe(2);
    const plain = stats.traitHoldings.find((holding) => holding.trait.name === 'plain');
    expect(plain?.share).toBeCloseTo(0.6);
  });

  it('reports nothing rather than dividing by zero when only commissions exist', () => {
    const stats = projectStats(COMMISSIONS, pack());

    expect(stats.countedClaims).toBe(0);
    expect(stats.customClaims).toBe(3);
    expect(stats.traitHoldings).toEqual([]);
    // Null, not the date of a commission: a commission is not a claim this
    // report knows about, so it cannot be the latest one.
    expect(stats.latestClaimAt).toBeNull();
  });
});
