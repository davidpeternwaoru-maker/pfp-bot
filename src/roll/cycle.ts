import { buildExclusionIndex, hasExcludedPair } from '../render/exclusions.js';
import { openTraits } from '../render/pack.js';
import type { TraitPack, TraitRecord } from '../render/types.js';

/**
 * Cycling one slot to its next option while every other slot stays put.
 *
 * This is the "adjust" half of the roll experience: a member who likes the
 * body but not the hat should be able to change only the hat.
 */

export interface CycleResult {
  readonly traits: readonly TraitRecord[];
  /**
   * False when every other option in the slot would have clashed with what the
   * member is already holding, so the combination is unchanged.
   */
  readonly changed: boolean;
}

/**
 * Resolves the member's current combination into trait records, slot by slot.
 * Returns null if it no longer fits the pack — a trait retired between the
 * roll and the button press, say — which the caller answers with a fresh roll
 * rather than by guessing at a repair.
 */
export function resolveCombination(
  pack: TraitPack,
  traitIds: readonly number[],
): readonly TraitRecord[] | null {
  if (traitIds.length !== pack.slots.length) {
    return null;
  }

  const traits: TraitRecord[] = [];

  for (const [index, slot] of pack.slots.entries()) {
    const wanted = traitIds[index];
    const found = slot.traits.find((trait) => trait.id === wanted);
    if (found === undefined) {
      return null;
    }
    traits.push(found);
  }

  return traits;
}

export function cycleSlot(
  pack: TraitPack,
  current: readonly TraitRecord[],
  slotIndex: number,
): CycleResult | null {
  const slot = pack.slots[slotIndex];
  if (slot === undefined || current.length !== pack.slots.length) {
    return null;
  }

  const options = openTraits(slot);
  if (options.length === 0) {
    return null;
  }

  const exclusions = buildExclusionIndex(pack.exclusions);
  const currentTrait = current[slotIndex];
  const currentPosition = options.findIndex((option) => option.id === currentTrait?.id);

  // A slot currently holding something outside the open pool — an awarded
  // legendary — starts its cycle at the first open option rather than nowhere.
  const start = currentPosition === -1 ? -1 : currentPosition;

  for (let step = 1; step <= options.length; step += 1) {
    const candidate = options[(start + step + options.length) % options.length];
    if (candidate === undefined || candidate.id === currentTrait?.id) {
      continue;
    }

    const proposed = current.map((trait, index) => (index === slotIndex ? candidate : trait));

    // Skipping rather than rejecting: the member pressed a button and expects
    // something to change, so step over clashing options to the next usable one.
    if (
      hasExcludedPair(
        exclusions,
        proposed.map((trait) => trait.id),
      )
    ) {
      continue;
    }

    return { traits: proposed, changed: true };
  }

  return { traits: current, changed: false };
}
