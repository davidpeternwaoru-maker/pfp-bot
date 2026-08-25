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
  transparentCanvas,
} from './render/image.js';
export type { TraitImageOptions } from './render/image.js';

/** The "none" option every slot carries. An importer has to create these. */
export { ensureNoneImage, NONE_TRAIT_NAME, noneImagePath } from './render/none.js';

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

export {
  currentCombination,
  guardClaim,
  loadPack,
  openBrowse,
  presentHeld,
  rollFresh,
  rollPickOption,
  rollSlotCycle,
} from './services/roll-service.js';
export type {
  BrowseResult,
  ClaimGuard,
  RolledCombination,
  RollDependencies,
  RollResult,
  SlotCycleResult,
} from './services/roll-service.js';

/** Browsing a slot by name, for a member who knows what they want. */
export { BROWSE_PAGE_SIZE, browsePageCount, clampBrowsePage } from './roll/browse.js';
export type { BrowseOption, BrowseView } from './roll/browse.js';

/** What to offer somebody who has landed on a combination already held. */
export type { CollisionAdvice } from './roll/collision.js';

export { attemptClaim } from './services/claim-flow-service.js';
export type { ClaimAttempt, ClaimFlowDependencies } from './services/claim-flow-service.js';

export { claimCombination } from './claim/claim-service.js';
export type { ClaimedRecord, ClaimOutcome, ClaimRequest } from './claim/claim-service.js';

export { awardCombination } from './claim/award-service.js';
export type { AwardOutcome, AwardRequest } from './claim/award-service.js';

export { issueOneOfOne } from './claim/one-of-one-service.js';
export type { OneOfOneKind, OneOfOneOutcome, OneOfOneRequest } from './claim/one-of-one-service.js';

export { CLAIM_TYPES } from './claim/types.js';
export type { ClaimType, MemberSlot } from './claim/types.js';

export { loadClaimArtwork } from './claim/artwork.js';

// ---------------------------------------------------------------------------
// Reading what members hold
// ---------------------------------------------------------------------------

export {
  findCollection,
  findMemberClaims,
  findStatsClaims,
  loadClaimedHashes,
} from './db/claim-repository.js';
export type { CollectionEntry, MemberClaim } from './db/claim-repository.js';

/** Rarity and supply. Commissions are excluded inside, never by the caller. */
export { projectStats } from './stats.js';
export type { ProjectStats, StatsClaim, TraitHolding } from './stats.js';

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
// Wallets: proved by signature, never by a typed address
// ---------------------------------------------------------------------------

/**
 * Linking gates token features and nothing else. No path here ever requests,
 * accepts, transmits, logs or stores a private key or a seed phrase.
 */
export { completeLink, findLinkedWallet, unlinkWallet } from './wallet/link-service.js';
export type { LinkedWallet, LinkOutcome, LinkRejection } from './wallet/link-service.js';

export {
  CHALLENGE_TTL_MS,
  consumeChallenge,
  findPendingChallenge,
  issueChallenge,
  pruneChallenges,
} from './wallet/challenge.js';
export type { IssuedChallenge, IssueResult, PendingChallenge } from './wallet/challenge.js';

/** The exact text a member signs. Built identically on both sides. */
export { challengeMessage } from './wallet/message.js';
export type { ChallengeMessageInput } from './wallet/message.js';

export { parseSolanaAddress } from './wallet/address.js';
export type { AddressResult, SolanaAddress } from './wallet/address.js';

/** Read-only, and denies on every error path. Never signs, never holds funds. */
export { meetsThreshold, readTokenBalance, scaleThreshold } from './wallet/balance.js';
export type { BalanceOutcome, TokenBalance } from './wallet/balance.js';

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
  BrowseState,
  InMemorySessionStoreOptions,
  RollSession,
  RollSessionInput,
  RollSessionStore,
} from './session.js';

/**
 * Cached "is this taken" answers, for what a front end shows. Never for what
 * it enforces — a claim is decided by a unique index and nothing else.
 */
export { createAvailability } from './roll/availability.js';
export type { Availability, AvailabilityOptions } from './roll/availability.js';

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

// ---------------------------------------------------------------------------
// Commissions: artwork a member orders and pays for
// ---------------------------------------------------------------------------

export {
  COMMISSION_PALETTE,
  COMMISSION_STATUSES,
  DECLINE_REASONS,
  isPaletteColour,
  isTerminal,
  MAX_REVISION,
} from './commission/types.js';
export type { CommissionColour, CommissionStatus, DeclineReason } from './commission/types.js';

export { MAX_NOTE_LENGTH, MAX_TEXT_LENGTH, validateBrief } from './commission/brief.js';
export type { BriefInput, BriefProblem, BriefResult, ValidBrief } from './commission/brief.js';

/** The approval gate, as a table. Nothing reaches production without it. */
export {
  allowedNext,
  canTransition,
  formatUsdc,
  occupiesOrderSlot,
  owesRefund,
  treasuryShareCents,
} from './commission/lifecycle.js';

export {
  balanceReaderFor,
  checkEligibility,
  monthStart,
  nextMonthStart,
} from './commission/eligibility.js';
export type {
  CommissionTerms,
  EligibilityInput,
  EligibilityOutcome,
  EligibilityRefusal,
} from './commission/eligibility.js';

export { addRevision, placeOrder, transitionCommission } from './commission/order-service.js';
export type {
  PlaceOrderOutcome,
  RevisionOutcome,
  TransitionOutcome,
} from './commission/order-service.js';

export {
  countAcceptedThisMonth,
  findCommission,
  findCommissionTerms,
  findMemberCommissions,
  findOpenCommission,
  findOperatorQueue,
  findWaitlist,
  joinWaitlist,
  payablesReport,
} from './db/commission-repository.js';
export type {
  BriefView,
  CommissionView,
  PayableLine,
  PayablesReport,
} from './db/commission-repository.js';

/** The questionnaire, as a step machine a front end renders but does not decide. */
export {
  answer,
  attachReference,
  DRAFT_STEPS,
  finish,
  promptFor,
  skip,
  startDraft,
  summarise,
} from './commission/draft.js';
export type {
  AnswerResult,
  CommissionDraft,
  DraftStep,
  DraftSummary,
  FinishResult,
  Prompt,
} from './commission/draft.js';

export { createInMemoryDraftStore } from './commission/draft-store.js';
export type { CommissionDraftStore, DraftStoreOptions } from './commission/draft-store.js';
