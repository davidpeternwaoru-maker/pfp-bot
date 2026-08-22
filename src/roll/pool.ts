import { buildExclusionIndex, hasExcludedPair } from '../render/exclusions.js';
import { combinationHash } from '../render/hash.js';
import { openTraits } from '../render/pack.js';
import { selectOpenCombination } from '../render/select.js';
import type { RandomSource } from '../render/select.js';
import type { TraitPack, TraitRecord } from '../render/types.js';

/**
 * Drawing a combination nobody has claimed yet.
 *
 * Two strategies, in order. Random draws are cheap and respect rarity weights,
 * which is what a member should normally get. They stop being reliable once
 * most of the pool is gone — at 95% claimed, a random draw misses 19 times out
 * of 20 — so there is a bounded sweep behind them. Neither can loop forever.
 */

export type DrawOutcome =
  | { readonly kind: 'drawn'; readonly traits: readonly TraitRecord[]; readonly hash: string }
  /** Every combination in the pool is claimed. The collection is finished. */
  | { readonly kind: 'exhausted' }
  /**
   * Free combinations may well remain, but neither strategy found one within
   * its budget. Distinct from `exhausted` on purpose: telling a member the
   * collection is finished when it is not would be a lie they act on.
   */
  | { readonly kind: 'undetermined'; readonly examined: number };

export interface DrawOptions {
  readonly pack: TraitPack;
  /** Claimed combination hashes for this project. */
  readonly isClaimed: (hash: string) => boolean;
  readonly random?: RandomSource;
  /** Weighted attempts before falling back to the sweep. */
  readonly randomAttempts?: number;
  /** Hard ceiling on combinations examined during the sweep. */
  readonly maxEnumerated?: number;
}

const DEFAULT_RANDOM_ATTEMPTS = 12;

/**
 * A sweep this size costs a few milliseconds of hashing. Past it, the pool is
 * either enormous — in which case a random draw would have landed already — or
 * so nearly exhausted that the honest answer is "try again".
 */
const DEFAULT_MAX_ENUMERATED = 50_000;

/** Open options per slot, in layer order. Empty slot means an empty pool. */
function optionsPerSlot(pack: TraitPack): readonly (readonly TraitRecord[])[] {
  return pack.slots.map((slot) => openTraits(slot));
}

function totalCombinations(options: readonly (readonly TraitRecord[])[]): number {
  let total = 1;
  for (const slotOptions of options) {
    total *= slotOptions.length;
    if (total === 0) {
      return 0;
    }
  }
  return total;
}

/**
 * Maps one integer onto one combination, treating the slot option counts as
 * digits of a mixed-radix number. Lets the sweep visit the whole pool in a
 * fixed order without ever materialising it.
 */
function combinationAt(
  options: readonly (readonly TraitRecord[])[],
  index: number,
): readonly TraitRecord[] {
  const traits: TraitRecord[] = [];
  let remaining = index;

  for (const slotOptions of options) {
    const size = slotOptions.length;
    const chosen = slotOptions[remaining % size];
    if (chosen === undefined) {
      throw new RangeError('combinationAt indexed past the end of a slot');
    }
    traits.push(chosen);
    remaining = Math.floor(remaining / size);
  }

  return traits;
}

export function drawUnclaimed(options: DrawOptions): DrawOutcome {
  const { pack, isClaimed } = options;
  const random = options.random ?? Math.random;
  const randomAttempts = options.randomAttempts ?? DEFAULT_RANDOM_ATTEMPTS;
  const maxEnumerated = options.maxEnumerated ?? DEFAULT_MAX_ENUMERATED;

  const exclusions = buildExclusionIndex(pack.exclusions);
  const perSlot = optionsPerSlot(pack);
  const total = totalCombinations(perSlot);

  // No open option in some slot means no combination can be formed at all.
  if (total === 0) {
    return { kind: 'exhausted' };
  }

  for (let attempt = 0; attempt < randomAttempts; attempt += 1) {
    const traits = selectOpenCombination(pack, random);
    const ids = traits.map((trait) => trait.id);
    if (hasExcludedPair(exclusions, ids)) {
      continue;
    }
    const hash = combinationHash(ids);
    if (!isClaimed(hash)) {
      return { kind: 'drawn', traits, hash };
    }
  }

  // Start the sweep somewhere random, so a nearly-full pool does not hand the
  // same combination to everyone who happens to reroll at the same moment.
  const offset = Math.floor(random() * total) % total;
  const budget = Math.min(total, maxEnumerated);

  for (let step = 0; step < budget; step += 1) {
    const traits = combinationAt(perSlot, (offset + step) % total);
    const ids = traits.map((trait) => trait.id);
    if (hasExcludedPair(exclusions, ids)) {
      continue;
    }
    const hash = combinationHash(ids);
    if (!isClaimed(hash)) {
      return { kind: 'drawn', traits, hash };
    }
  }

  // Only a sweep that covered the entire pool can prove it is exhausted.
  return budget >= total ? { kind: 'exhausted' } : { kind: 'undetermined', examined: budget };
}
