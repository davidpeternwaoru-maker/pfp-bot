/**
 * The contract between the product and any front end.
 *
 * Everything an adapter — Telegram, the admin CLI, a future web or Discord
 * front end — is allowed to use lives here. Adapters import from this module
 * and nowhere else in core, which is enforced by lint rather than trusted.
 *
 * Two things follow from that, and both are the point:
 *
 * Adding a front end is a matter of implementing against one named surface
 * rather than discovering which twenty files happened to be importable. If a
 * new adapter needs something not exported here, that is a deliberate decision
 * to widen the contract, made once and visibly.
 *
 * Nothing in this file mentions a chat, a message, a keyboard or a user
 * object. Every operation takes plain arguments and returns plain data. A
 * signature that needed a chat id would be a signature in the wrong layer.
 */

// ---------------------------------------------------------------------------
// Artwork and trait packs
// ---------------------------------------------------------------------------

export { TRAIT_TIERS } from './render/types.js';
export type {
  CanvasSize,
  ExclusionPair,
  TraitPack,
  TraitRecord,
  TraitSlot,
  TraitTier,
} from './render/types.js';

export { buildTraitPack, openPoolCapacity, openTraits } from './render/pack.js';
export type { TraitPackInput } from './render/pack.js';

export {
  compositeLayers,
  loadTraitImage,
  MAX_TRAIT_IMAGE_BYTES,
  renderCombination,
} from './render/image.js';
export type { TraitImageOptions } from './render/image.js';

export { createRenderCache, renderCacheKey } from './render/cache.js';
export type { RenderCache, RenderCacheOptions } from './render/cache.js';

/** Adapters report these as an operator problem, never as a member's fault. */
export { EmptySlotError, TraitImageError, TraitPackError } from './render/errors.js';

// ---------------------------------------------------------------------------
// Identity and naming
// ---------------------------------------------------------------------------

export { MAX_SLUG_LENGTH, parseSlug } from './slug.js';
export type { SlugRejection, SlugResult } from './slug.js';

export { findMemberByHandle, findMemberByIdentity, resolveMember } from './db/member-repository.js';
export type { MemberIdentity, MemberProfile, MemberRef } from './db/member-repository.js';

// ---------------------------------------------------------------------------
// Entry: what a member sees when they open a project
// ---------------------------------------------------------------------------

export { resolveEntry } from './entry.js';
export type { EntryExistingClaim, EntryInput, EntryOutcome, EntryProject } from './entry.js';

// ---------------------------------------------------------------------------
// Rolling and claiming
// ---------------------------------------------------------------------------

export { currentCombination, loadPack, rollFresh, rollSlotCycle } from './services/roll-service.js';
export type {
  RolledCombination,
  RollDependencies,
  RollResult,
  SlotCycleResult,
} from './services/roll-service.js';

export { attemptClaim } from './services/claim-flow-service.js';
export type { ClaimAttempt, ClaimFlowDependencies } from './services/claim-flow-service.js';

export { claimCombination } from './claim/claim-service.js';
export type { ClaimedRecord, ClaimOutcome, ClaimRequest } from './claim/claim-service.js';

export { awardCombination } from './claim/award-service.js';
export type { AwardOutcome, AwardRequest } from './claim/award-service.js';

export { loadClaimArtwork } from './claim/artwork.js';

// ---------------------------------------------------------------------------
// Reading what members hold
// ---------------------------------------------------------------------------

export { findCollection, findMemberClaims, loadClaimedHashes } from './db/claim-repository.js';
export type { CollectionEntry, MemberClaim } from './db/claim-repository.js';

export { clampPage, collectionPage, COLLECTION_PAGE_SIZE, pageCountFor } from './collection.js';
export type { CollectionPageView } from './collection.js';

export {
  findAnnounceSettings,
  findClaimForMember,
  findProjectById,
  findProjectBySlug,
} from './db/project-repository.js';
export type { ClaimAnnounceSettings } from './db/project-repository.js';

export { fetchTraitPack } from './db/trait-pack-repository.js';

// ---------------------------------------------------------------------------
// State an adapter supplies or shares
// ---------------------------------------------------------------------------

/**
 * Where an in-progress roll lives. Keyed by member and project only: where the
 * roll is *displayed* is the adapter's business, and keeping a message id here
 * would force a second front end to invent one.
 */
export { createInMemorySessionStore, sessionKey } from './session.js';
export type {
  InMemorySessionStoreOptions,
  RollSession,
  RollSessionInput,
  RollSessionStore,
} from './session.js';

/** Rolling and rendering are CPU-bound, so every front end needs this. */
export { createRateLimiter } from './rate-limit.js';
export type { RateLimitDecision, RateLimiter, RateLimiterOptions } from './rate-limit.js';

// ---------------------------------------------------------------------------
// Infrastructure an adapter has to wire up
// ---------------------------------------------------------------------------

export { createPrismaClient } from './db/client.js';

/** The one check between operator input and reading arbitrary files. */
export { resolveWithinRoot } from './fs/within-root.js';
export type { ContainmentFailure, ContainmentResult } from './fs/within-root.js';
