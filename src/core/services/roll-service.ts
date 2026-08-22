import { loadClaimedHashes } from '../db/claim-repository.js';
import { fetchTraitPack } from '../db/trait-pack-repository.js';
import { renderCacheKey } from '../render/cache.js';
import type { RenderCache } from '../render/cache.js';
import { combinationHash } from '../render/hash.js';
import { renderCombination } from '../render/image.js';
import type { TraitPack, TraitRecord } from '../render/types.js';
import { drawUnclaimed } from '../roll/pool.js';
import { cycleSlot, resolveCombination } from '../roll/cycle.js';
import type { RollSessionStore } from '../session.js';
import type { Logger } from '../../logging/logger.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Rolling, as a product operation.
 *
 * Every function here answers "what should this member be looking at now" and
 * returns the artwork and the traits. None of them knows how that gets shown —
 * no message, no chat, no keyboard. A web or Discord front end calls exactly
 * these and renders the result its own way.
 */

export interface RollDependencies {
  readonly prisma: PrismaClient;
  readonly sessions: RollSessionStore;
  readonly renderCache: RenderCache;
  readonly traitRoot: string;
  readonly logger: Logger;
}

/** A combination ready to display, with its rendered bytes. */
export interface RolledCombination {
  readonly traits: readonly TraitRecord[];
  readonly traitIds: readonly number[];
  readonly image: Buffer;
}

export type RollResult =
  | { readonly kind: 'rolled'; readonly combination: RolledCombination }
  /** Every combination in the open pool is already claimed. */
  | { readonly kind: 'exhausted' }
  /** The pool could not be sampled confidently; the caller should say so. */
  | { readonly kind: 'undetermined' };

export type SlotCycleResult =
  | { readonly kind: 'rolled'; readonly combination: RolledCombination }
  /** Every other option in the slot would break an exclusion. */
  | { readonly kind: 'unchanged' }
  /** The session no longer holds a combination this pack can resolve. */
  | { readonly kind: 'stale' };

export async function loadPack(deps: RollDependencies, projectId: number): Promise<TraitPack> {
  return fetchTraitPack(deps.prisma, projectId);
}

/**
 * Renders a combination, using the cache when the same one has been seen
 * recently. Rerolling back and forth is normal, and re-encoding an identical
 * PNG for it is pure waste.
 */
async function renderCached(
  deps: RollDependencies,
  pack: TraitPack,
  traits: readonly TraitRecord[],
): Promise<Buffer> {
  const hash = combinationHash(traits.map((trait) => trait.id));
  const key = renderCacheKey(pack.projectId, hash);

  const cached = deps.renderCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const image = await renderCombination(traits, { canvas: pack.canvas, root: deps.traitRoot });
  deps.renderCache.set(key, image);
  return image;
}

async function present(
  deps: RollDependencies,
  pack: TraitPack,
  memberId: number,
  traits: readonly TraitRecord[],
): Promise<RolledCombination> {
  const image = await renderCached(deps, pack, traits);
  const traitIds = traits.map((trait) => trait.id);

  // Recorded before anything is displayed: what the member is looking at must
  // be readable from the server, never from what the client sends back.
  await deps.sessions.set({ memberId, projectId: pack.projectId, traitIds });

  return { traits, traitIds, image };
}

/** Draws a fresh combination nobody has claimed yet. */
export async function rollFresh(
  deps: RollDependencies,
  pack: TraitPack,
  memberId: number,
): Promise<RollResult> {
  const claimed = await loadClaimedHashes(deps.prisma, pack.projectId);
  const draw = drawUnclaimed({ pack, isClaimed: (hash) => claimed.has(hash) });

  if (draw.kind === 'exhausted') {
    deps.logger.info('roll.pool_exhausted', { projectId: pack.projectId });
    return { kind: 'exhausted' };
  }
  if (draw.kind === 'undetermined') {
    deps.logger.warn('roll.pool_undetermined', { projectId: pack.projectId });
    return { kind: 'undetermined' };
  }

  return { kind: 'rolled', combination: await present(deps, pack, memberId, draw.traits) };
}

/** Advances one slot to its next legal option, holding every other slot fixed. */
export async function rollSlotCycle(
  deps: RollDependencies,
  pack: TraitPack,
  memberId: number,
  currentTraitIds: readonly number[],
  slotIndex: number,
): Promise<SlotCycleResult> {
  const current = resolveCombination(pack, currentTraitIds);
  if (current === null) {
    return { kind: 'stale' };
  }

  const cycled = cycleSlot(pack, current, slotIndex);
  if (cycled === null) {
    return { kind: 'stale' };
  }

  // Every other option in the slot would have clashed, so nothing moved. Said
  // plainly rather than re-rendering an identical image.
  if (!cycled.changed) {
    return { kind: 'unchanged' };
  }

  return { kind: 'rolled', combination: await present(deps, pack, memberId, cycled.traits) };
}

/** The combination a session is holding, if the pack can still resolve it. */
export function currentCombination(
  pack: TraitPack,
  traitIds: readonly number[],
): readonly TraitRecord[] | null {
  return resolveCombination(pack, traitIds);
}
