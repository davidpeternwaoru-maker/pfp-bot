import { EmptySlotError } from './errors.js';
import { openTraits } from './pack.js';
import type { TraitPack, TraitRecord } from './types.js';

/** Injectable so tests can drive the selector with a known sequence. */
export type RandomSource = () => number;

/**
 * Picks one item with probability proportional to its weight.
 * Weights are validated as integers >= 1 when the pack is built, so the total
 * is always positive and every item stays reachable.
 */
export function weightedPick<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  random: RandomSource,
): T {
  if (items.length === 0) {
    throw new RangeError('weightedPick received an empty list');
  }

  let total = 0;
  for (const item of items) {
    total += weightOf(item);
  }

  let threshold = random() * total;
  for (const item of items) {
    threshold -= weightOf(item);
    if (threshold < 0) {
      return item;
    }
  }

  // Only reachable if random() returns exactly 1, which Math.random never does.
  // Falling back to the last item keeps the function total rather than throwing.
  const last = items[items.length - 1];
  if (last === undefined) {
    throw new RangeError('weightedPick received an empty list');
  }
  return last;
}

/**
 * One trait per slot from the open pool, in bottom-to-top layer order.
 *
 * Gated and legendary traits are filtered out here rather than at the caller:
 * reserved artwork must never be reachable by rolling, only by an award.
 */
export function selectOpenCombination(
  pack: TraitPack,
  random: RandomSource = Math.random,
): readonly TraitRecord[] {
  return pack.slots.map((slot) => {
    const candidates = openTraits(slot);
    if (candidates.length === 0) {
      throw new EmptySlotError(slot.slot);
    }
    return weightedPick(candidates, (trait) => trait.rarityWeight, random);
  });
}
