import { buildExclusionIndex, hasExcludedPair } from '../render/exclusions.js';
import { combinationHash } from '../render/hash.js';
import { openTraits } from '../render/pack.js';
import type { TraitPack, TraitRecord } from '../render/types.js';

/**
 * What to say when a member assembles a combination somebody already holds.
 *
 * Once a member can browse to an exact option, collisions stop being a race
 * they lost and become a thing they deliberately walked into. That is not a
 * failure state — it is the moment scarcity becomes real to them — but it is
 * only bearable if it names a way out. "Taken" on its own is a dead end;
 * "taken, and changing the hat or the eyes would free it" is a next tap.
 *
 * Nothing here reveals who holds it. Which member owns a combination is not a
 * member's business, and naming them invites exactly the pressure this product
 * should never create.
 */

export interface CollisionAdvice {
  /** Slot names where some other option yields a free combination. */
  readonly freeingSlots: readonly string[];
  /**
   * True when no single change frees it. Rare, and it means the neighbourhood
   * is claimed out rather than that this combination is special.
   */
  readonly stuck: boolean;
}

/**
 * Which single slot changes would land on a combination nobody holds.
 *
 * One change at a time, not two: a member is choosing the next tap, and a hint
 * that requires two simultaneous edits is not advice they can act on. Slots are
 * returned in pack order so the wording matches the buttons on screen.
 */
export function collisionAdvice(
  pack: TraitPack,
  current: readonly TraitRecord[],
  isClaimed: (hash: string) => boolean,
): CollisionAdvice {
  if (current.length !== pack.slots.length) {
    return { freeingSlots: [], stuck: true };
  }

  const exclusions = buildExclusionIndex(pack.exclusions);
  const freeingSlots: string[] = [];

  for (const [slotIndex, slot] of pack.slots.entries()) {
    const held = current[slotIndex];

    const frees = openTraits(slot).some((option) => {
      if (option.id === held?.id) {
        return false;
      }
      const proposed = current.map((trait, index) => (index === slotIndex ? option : trait));
      const ids = proposed.map((trait) => trait.id);
      if (hasExcludedPair(exclusions, ids)) {
        return false;
      }
      return !isClaimed(combinationHash(ids));
    });

    if (frees) {
      freeingSlots.push(slot.slot);
    }
  }

  return { freeingSlots, stuck: freeingSlots.length === 0 };
}
