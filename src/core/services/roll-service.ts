import { loadClaimedHashes } from '../db/claim-repository.js';
import { fetchTraitPack } from '../db/trait-pack-repository.js';
import { renderCacheKey } from '../render/cache.js';
import type { RenderCache } from '../render/cache.js';
import { combinationHash } from '../render/hash.js';
import { renderCombination } from '../render/image.js';
import type { TraitPack, TraitRecord } from '../render/types.js';
import { drawUnclaimed } from '../roll/pool.js';
import { browseSlot, pickOption } from '../roll/browse.js';
import type { BrowseView } from '../roll/browse.js';
import { collisionAdvice } from '../roll/collision.js';
import type { CollisionAdvice } from '../roll/collision.js';
import type { Availability } from '../roll/availability.js';
import { cycleSlot, resolveCombination } from '../roll/cycle.js';
import type { BrowseState, RollSessionStore } from '../session.js';
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
  /** Briefly cached claimed hashes, for what is shown — never for what is enforced. */
  readonly availability: Availability;
  readonly traitRoot: string;
  readonly logger: Logger;
}

/** A combination ready to display, with its rendered bytes. */
export interface RolledCombination {
  readonly traits: readonly TraitRecord[];
  readonly traitIds: readonly number[];
  readonly image: Buffer;
  /**
   * Whether nobody holds this combination, as of a moment ago.
   *
   * Advisory, and deliberately so. The claim itself is decided by a unique
   * index, so a true here is an encouragement rather than a reservation, and a
   * false is certain — a combination that is taken does not become free again.
   */
  readonly available: boolean;
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

export type BrowseResult =
  { readonly kind: 'browsing'; readonly view: BrowseView } | { readonly kind: 'stale' };

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

/**
 * Renders the option a member is most likely to ask for next, into the cache,
 * while they are still looking at this one.
 *
 * Only ever after a slot cycle, and only the next option in that same slot:
 * somebody who has just pressed "hat" is far more likely to press it again than
 * to do anything else, and encoding a PNG takes long enough to be visible.
 * Guessing more widely would burn CPU on combinations nobody asks for.
 *
 * Never awaited and never allowed to throw. This is a bet on what happens next,
 * and a lost bet must cost the member nothing at all — not an error, not a
 * delay, not a log line they caused.
 */
function warmNextInSlot(
  deps: RollDependencies,
  pack: TraitPack,
  traits: readonly TraitRecord[],
  slotIndex: number,
): void {
  const next = cycleSlot(pack, traits, slotIndex);
  if (next === null || !next.changed) {
    return;
  }

  const hash = combinationHash(next.traits.map((trait) => trait.id));
  if (deps.renderCache.get(renderCacheKey(pack.projectId, hash)) !== undefined) {
    return;
  }

  void renderCached(deps, pack, next.traits).catch((error: unknown) => {
    deps.logger.debug('roll.speculative_render_failed', {
      projectId: pack.projectId,
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}

async function present(
  deps: RollDependencies,
  pack: TraitPack,
  memberId: number,
  traits: readonly TraitRecord[],
): Promise<RolledCombination> {
  const traitIds = traits.map((trait) => trait.id);

  // Both reads start together: the render is CPU-bound and the availability
  // check is usually a cache hit, so waiting for one before starting the other
  // would add latency to the tap for no reason.
  const [image, claimed] = await Promise.all([
    renderCached(deps, pack, traits),
    deps.availability.claimedHashes(pack.projectId),
  ]);

  // Recorded before anything is displayed: what the member is looking at must
  // be readable from the server, never from what the client sends back.
  // Showing artwork always closes any open slot list.
  await deps.sessions.set({ memberId, projectId: pack.projectId, traitIds, browse: null });

  return {
    traits,
    traitIds,
    image,
    available: !claimed.has(combinationHash(traitIds)),
  };
}

/**
 * Puts back what the member already holds, with a freshly checked availability
 * line and any open slot list closed.
 *
 * Closing a list is not a change of combination, but it is a change of what the
 * screen should say: somebody may have claimed this while they were reading
 * option names. Re-presenting rather than restoring the old caption is what
 * keeps the tick on screen honest.
 */
export async function presentHeld(
  deps: RollDependencies,
  pack: TraitPack,
  memberId: number,
  traits: readonly TraitRecord[],
): Promise<RolledCombination> {
  return present(deps, pack, memberId, traits);
}

/** Draws a fresh combination nobody has claimed yet. */
export async function rollFresh(
  deps: RollDependencies,
  pack: TraitPack,
  memberId: number,
): Promise<RollResult> {
  // Read straight through rather than from the availability cache. This one
  // decides what a member is handed, not what a caption says, and handing
  // somebody a combination that was claimed two seconds ago would turn a fresh
  // roll into an apology.
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

  const combination = await present(deps, pack, memberId, cycled.traits);
  warmNextInSlot(deps, pack, cycled.traits, slotIndex);

  return { kind: 'rolled', combination };
}

/** Opens a slot's list of options, or moves to another page of it. */
export async function openBrowse(
  deps: RollDependencies,
  pack: TraitPack,
  memberId: number,
  currentTraitIds: readonly number[],
  slotIndex: number,
  pageIndex: number,
): Promise<BrowseResult> {
  const current = resolveCombination(pack, currentTraitIds);
  if (current === null) {
    return { kind: 'stale' };
  }

  const view = browseSlot(pack, current, slotIndex, pageIndex);
  if (view === null) {
    return { kind: 'stale' };
  }

  // The clamped page is stored, not the requested one, so a position sent back
  // is resolved against the page that was actually drawn.
  await deps.sessions.set({
    memberId,
    projectId: pack.projectId,
    traitIds: currentTraitIds,
    browse: { slotIndex: view.slotIndex, pageIndex: view.pageIndex },
  });

  return { kind: 'browsing', view };
}

/**
 * Applies the option at a position on the page the member has open.
 *
 * The browse state comes from the session and the position from the button, so
 * the pair can only ever address something the server itself put on screen.
 */
export async function rollPickOption(
  deps: RollDependencies,
  pack: TraitPack,
  memberId: number,
  currentTraitIds: readonly number[],
  browse: BrowseState,
  positionOnPage: number,
): Promise<SlotCycleResult> {
  const current = resolveCombination(pack, currentTraitIds);
  if (current === null) {
    return { kind: 'stale' };
  }

  const picked = pickOption(pack, current, browse.slotIndex, browse.pageIndex, positionOnPage);

  // The position addresses nothing on the open page — a forged payload, or a
  // page that shrank under them. Reported as "nothing moved" rather than as a
  // dead session: the combination they built is still perfectly good, and
  // throwing it away over an unusable button press would lose more than the
  // press was ever worth.
  if (picked === null) {
    return { kind: 'unchanged' };
  }

  // Picking what is already selected is not an error and not a change: the
  // member gets their artwork back with the list closed, which is what
  // tapping the highlighted option plainly means.
  const combination = await present(deps, pack, memberId, picked);
  return { kind: 'rolled', combination };
}

export interface ClaimGuard {
  readonly available: boolean;
  /** How to get off this combination. Null while it is still free. */
  readonly advice: CollisionAdvice | null;
}

/**
 * Whether a combination is still worth confirming, and what to change if not.
 *
 * Checked before the confirmation prompt rather than after it, because once a
 * member can browse to an exact combination they can deliberately assemble one
 * somebody already holds. Walking them through "claim this permanently?" and
 * then refusing would make the product look like it had not been paying
 * attention.
 *
 * This is not the check that keeps claims unique — that is a unique index, and
 * it stays that way. This one exists to make the refusal arrive at the moment
 * it is useful, and it computes the advice only when there is bad news, so the
 * ordinary path costs one set lookup.
 */
export async function guardClaim(
  deps: RollDependencies,
  pack: TraitPack,
  traits: readonly TraitRecord[],
): Promise<ClaimGuard> {
  const claimed = await deps.availability.claimedHashes(pack.projectId);
  const isClaimed = (hash: string): boolean => claimed.has(hash);

  if (!isClaimed(combinationHash(traits.map((trait) => trait.id)))) {
    return { available: true, advice: null };
  }

  return { available: false, advice: collisionAdvice(pack, traits, isClaimed) };
}

/** The combination a session is holding, if the pack can still resolve it. */
export function currentCombination(
  pack: TraitPack,
  traitIds: readonly number[],
): readonly TraitRecord[] | null {
  return resolveCombination(pack, traitIds);
}
