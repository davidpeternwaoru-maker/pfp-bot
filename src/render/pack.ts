import { TraitPackError } from './errors.js';
import type { CanvasSize, ExclusionPair, TraitPack, TraitRecord, TraitSlot } from './types.js';

export interface TraitPackInput {
  readonly projectId: number;
  readonly canvas: CanvasSize;
  readonly traits: readonly TraitRecord[];
  readonly exclusions: readonly ExclusionPair[];
}

function assertCanvas(canvas: CanvasSize): void {
  const { width, height } = canvas;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TraitPackError(`canvas size must be positive integers, got ${width}x${height}`);
  }
}

function assertTrait(trait: TraitRecord): void {
  if (!Number.isSafeInteger(trait.rarityWeight) || trait.rarityWeight < 1) {
    throw new TraitPackError(
      `trait ${trait.slot}/${trait.name} has rarityWeight ${String(trait.rarityWeight)}; ` +
        'weights must be integers of at least 1 so every option stays reachable',
    );
  }
  if (!Number.isSafeInteger(trait.layerOrder)) {
    throw new TraitPackError(`trait ${trait.slot}/${trait.name} has a non-integer layerOrder`);
  }
  if (trait.imagePath.length === 0) {
    throw new TraitPackError(`trait ${trait.slot}/${trait.name} has an empty imagePath`);
  }
}

/**
 * Groups traits into slots and validates the invariants a deterministic render
 * depends on. Pure: no filesystem, no database.
 */
export function buildTraitPack(input: TraitPackInput): TraitPack {
  assertCanvas(input.canvas);

  if (input.traits.length === 0) {
    throw new TraitPackError('trait pack contains no traits');
  }

  const bySlot = new Map<string, TraitRecord[]>();
  for (const trait of input.traits) {
    assertTrait(trait);
    const existing = bySlot.get(trait.slot);
    if (existing === undefined) {
      bySlot.set(trait.slot, [trait]);
    } else {
      existing.push(trait);
    }
  }

  const knownTraitIds = new Set(input.traits.map((trait) => trait.id));
  if (knownTraitIds.size !== input.traits.length) {
    throw new TraitPackError('trait pack contains duplicate trait ids');
  }

  const layerOwners = new Map<number, string>();
  const slots: TraitSlot[] = [];

  for (const [slot, traits] of bySlot) {
    // Every trait in a slot must sit at the same depth. If they disagreed, the
    // stacking order would depend on which option was rolled, so the same
    // combination could render two different images — and contentHash, which is
    // written into the claim, would stop being reproducible.
    const layerOrder = traits[0]?.layerOrder ?? 0;
    const mismatch = traits.find((trait) => trait.layerOrder !== layerOrder);
    if (mismatch !== undefined) {
      throw new TraitPackError(
        `slot "${slot}" mixes layerOrder ${String(layerOrder)} and ` +
          `${String(mismatch.layerOrder)}; all options in a slot must share one layer`,
      );
    }

    const owner = layerOwners.get(layerOrder);
    if (owner !== undefined) {
      throw new TraitPackError(
        `slots "${owner}" and "${slot}" both claim layerOrder ${String(layerOrder)}; ` +
          'stacking order would be ambiguous',
      );
    }
    layerOwners.set(layerOrder, slot);

    slots.push({
      slot,
      layerOrder,
      traits: [...traits].sort((a, b) => a.id - b.id),
    });
  }

  for (const pair of input.exclusions) {
    if (!knownTraitIds.has(pair.traitAId) || !knownTraitIds.has(pair.traitBId)) {
      throw new TraitPackError(
        `exclusion references a trait outside this pack: ` +
          `${String(pair.traitAId)}/${String(pair.traitBId)}`,
      );
    }
    if (pair.traitAId === pair.traitBId) {
      throw new TraitPackError(`exclusion pairs a trait with itself: ${String(pair.traitAId)}`);
    }
  }

  slots.sort((a, b) => a.layerOrder - b.layerOrder);

  return {
    projectId: input.projectId,
    canvas: input.canvas,
    slots,
    exclusions: [...input.exclusions],
  };
}

/** Open-tier options for a slot — the only ones the open pool may draw from. */
export function openTraits(slot: TraitSlot): readonly TraitRecord[] {
  return slot.traits.filter((trait) => trait.tier === 'open');
}

/**
 * Total open-pool combinations: the product of the option counts per slot.
 *
 * An upper bound, not an exact figure — exclusions remove some of these pairs.
 * Treat it as the ceiling when sizing a drop, never as guaranteed supply.
 */
export function openPoolCapacity(pack: TraitPack): number {
  let total = 1;
  for (const slot of pack.slots) {
    total *= openTraits(slot).length;
    if (total === 0) {
      return 0;
    }
  }
  return total;
}
