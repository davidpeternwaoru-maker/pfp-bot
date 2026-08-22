export const TRAIT_TIERS = ['open', 'gated', 'legendary'] as const;

export type TraitTier = (typeof TRAIT_TIERS)[number];

/**
 * A trait as the render engine sees it. Deliberately not the Prisma model:
 * everything here is pure and must stay testable without a database.
 */
export interface TraitRecord {
  readonly id: number;
  readonly slot: string;
  readonly name: string;
  readonly layerOrder: number;
  readonly imagePath: string;
  readonly rarityWeight: number;
  readonly tier: TraitTier;
}

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

export interface ExclusionPair {
  readonly traitAId: number;
  readonly traitBId: number;
}

export interface TraitSlot {
  readonly slot: string;
  readonly layerOrder: number;
  /** Sorted by id, so the same pack always yields the same ordering. */
  readonly traits: readonly TraitRecord[];
}

export interface TraitPack {
  readonly projectId: number;
  readonly canvas: CanvasSize;
  /** Ascending layerOrder — index 0 is the bottom layer. */
  readonly slots: readonly TraitSlot[];
  readonly exclusions: readonly ExclusionPair[];
}
