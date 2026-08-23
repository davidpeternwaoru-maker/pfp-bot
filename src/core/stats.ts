import type { ClaimType } from './claim/types.js';
import type { TraitPack, TraitRecord, TraitTier } from './render/types.js';

/**
 * Rarity and supply, as data.
 *
 * Custom claims are removed before anything is counted, and that exclusion
 * lives here rather than at each caller so no future caller can forget it. A
 * commission is artwork one member paid for privately; letting it move a
 * published figure would mean the scarcity a project promised its holders
 * changes every time somebody orders one. The holders would have been diluted
 * by a purchase they had no part in and could not see.
 *
 * Bespoke claims do count. The project paid for them as part of the drop, they
 * are transferable, and they are as much a part of the collection's supply as
 * anything rolled — so they dilute trait shares exactly as they should.
 *
 * Pure: no database, no filesystem. That is what lets the rule be tested by
 * running it twice rather than by trusting a query.
 */

export interface StatsClaim {
  readonly traitIds: readonly number[];
  readonly claimType: ClaimType;
  readonly tier: TraitTier;
  readonly claimedAt: Date;
}

export interface TraitHolding {
  readonly trait: TraitRecord;
  readonly count: number;
  /** Fraction of counted claims holding this trait, 0 to 1. */
  readonly share: number;
}

export interface ProjectStats {
  /** Claims that count toward rarity: everything except commissions. */
  readonly countedClaims: number;
  /** Counted claims a member rolled for themselves. */
  readonly rolledClaims: number;
  /** Counted claims an operator issued: trait awards and bespoke pieces. */
  readonly awardedClaims: number;
  /**
   * Commissions held in this project. Reported so an operator can see them,
   * and deliberately absent from every other number here.
   */
  readonly customClaims: number;
  /** Latest counted claim. Null when nothing counts yet. */
  readonly latestClaimAt: Date | null;
  /** Rarest first, then by trait id so equal counts always order the same. */
  readonly traitHoldings: readonly TraitHolding[];
}

export function projectStats(claims: readonly StatsClaim[], pack: TraitPack): ProjectStats {
  const counted = claims.filter((claim) => claim.claimType !== 'custom');
  const customClaims = claims.length - counted.length;

  // How often each trait actually appears, which is not the same as its
  // configured weight: exclusions and member choice both bend the outcome.
  const held = new Map<number, number>();
  let latestClaimAt: Date | null = null;
  let rolledClaims = 0;

  for (const claim of counted) {
    for (const id of claim.traitIds) {
      held.set(id, (held.get(id) ?? 0) + 1);
    }
    if (claim.tier === 'open') {
      rolledClaims += 1;
    }
    if (latestClaimAt === null || claim.claimedAt > latestClaimAt) {
      latestClaimAt = claim.claimedAt;
    }
  }

  const byId = new Map(
    pack.slots.flatMap((slot) => slot.traits.map((trait) => [trait.id, trait] as const)),
  );

  const traitHoldings: TraitHolding[] = [];
  for (const [id, count] of held) {
    const trait = byId.get(id);
    // A claim can outlive a trait row only if traits were replaced under it,
    // which the importer refuses. Skipping rather than throwing keeps a report
    // readable if it ever happens by another route.
    if (trait !== undefined) {
      traitHoldings.push({ trait, count, share: count / counted.length });
    }
  }
  traitHoldings.sort((a, b) => a.count - b.count || a.trait.id - b.trait.id);

  return {
    countedClaims: counted.length,
    rolledClaims,
    awardedClaims: counted.length - rolledClaims,
    customClaims,
    latestClaimAt,
    traitHoldings,
  };
}
