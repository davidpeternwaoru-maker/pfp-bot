import type { PrismaClient } from '../../generated/prisma/client.js';
import type { TraitTier } from '../render/types.js';
import { memberSlotKey } from './types.js';
import type { ClaimType, MemberSlot } from './types.js';

/**
 * The one place a Claim row is written.
 *
 * Every path — a rolled claim, an award, a bespoke piece, a commission — comes
 * through here so the edition counter, the claim type, the transferable flag
 * and the member slot key cannot drift apart between them. Conflicts are not
 * handled here: they are thrown so each caller can say what the collision
 * means to the person who caused it.
 */

/**
 * What produced this claim.
 *
 * One field rather than four, because claim type, transferability, which
 * member slot is consumed and whether the claim window applies are not
 * independent choices — they are four consequences of one fact. Letting a
 * caller set them separately is letting a caller set them inconsistently, and
 * an inconsistent claim row is permanent.
 */
export type ClaimKind =
  /** A member rolled it from the open pool. Consumes their open slot. */
  | 'rolled'
  /** An operator handed a member a reserved trait combination. */
  | 'awarded'
  /** An operator issued a one-of-one artwork the project paid for. */
  | 'bespoke'
  /** A member commissioned a one-of-one artwork. Consumes their custom slot. */
  | 'custom';

interface KindRules {
  readonly claimType: ClaimType;
  readonly transferable: boolean;
  /** Which of the member's two per-project slots this occupies, if either. */
  readonly slot: MemberSlot | null;
}

/**
 * The whole taxonomy, as a table.
 *
 * Only `rolled` is subject to the claim window. The other three are deliberate
 * acts with money or an operator behind them: an award after a drop closes is
 * the normal case, and a commission the member has already paid for must be
 * deliverable whenever the artwork is finished.
 */
const RULES: Record<ClaimKind, KindRules> = {
  rolled: { claimType: 'open', transferable: true, slot: 'open' },
  awarded: { claimType: 'open', transferable: true, slot: null },
  bespoke: { claimType: 'bespoke', transferable: true, slot: null },
  custom: { claimType: 'custom', transferable: false, slot: 'custom' },
};

export interface InsertClaimInput {
  readonly prisma: PrismaClient;
  readonly projectId: number;
  readonly memberId: number;
  readonly kind: ClaimKind;
  /** Empty for bespoke and custom: a one-of-one has no trait combination. */
  readonly traitIds: readonly number[];
  readonly combinationHash: string;
  readonly contentHash: string;
  readonly imagePath: string;
  readonly tier: TraitTier;
}

export type InsertClaimResult =
  | { readonly kind: 'inserted'; readonly id: number; readonly editionNumber: number }
  | { readonly kind: 'project-closed' };

/**
 * Prisma's default interactive transaction budget is five seconds. Concurrent
 * claims queue on a row lock, so a burst can legitimately spend longer waiting
 * than working, and timing out mid-burst would fail claims that were about to
 * succeed.
 */
const TRANSACTION_TIMEOUT_MS = 20_000;
const TRANSACTION_MAX_WAIT_MS = 15_000;

export async function insertClaim(input: InsertClaimInput): Promise<InsertClaimResult> {
  const { prisma, projectId, memberId } = input;
  const rules = RULES[input.kind];
  const slotKey = rules.slot === null ? null : memberSlotKey(memberId, rules.slot);

  const created = await prisma.$transaction(
    async (tx) => {
      // Locks the project row for the rest of the transaction, so concurrent
      // claims on this project queue rather than interleave. Without it, two
      // claims read the same MAX(editionNumber) and both try to use it.
      //
      // The status is read by the same statement that takes the lock. Every
      // round trip here is made while holding an exclusive lock that all other
      // claimants are queued behind, so each one costs a full network latency
      // of throughput for the whole project, not just for this claimant.
      const projects = await tx.$queryRaw<
        { status: string; claimClosesAt: Date | null }[]
      >`SELECT "status"::text, "claimClosesAt" FROM "Project" WHERE id = ${projectId} FOR UPDATE`;

      const project = projects[0];
      if (project === undefined) {
        return null;
      }

      // Fail closed for members rolling the open pool. Nothing else is gated
      // on the window; see RULES above for why.
      if (input.kind === 'rolled') {
        if (project.status !== 'live') {
          return null;
        }
        if (project.claimClosesAt !== null && new Date() >= project.claimClosesAt) {
          return null;
        }
      }

      // The edition number is chosen and the row written by one statement, so
      // the counter is read inside the same round trip that uses it. Safe only
      // because of the lock above; without it, two of these would still read
      // the same MAX. The unique index remains the thing that guarantees it.
      const inserted = await tx.$queryRaw<{ id: number; editionNumber: number }[]>`
        INSERT INTO "Claim" (
          "projectId", "memberId", "traitIds", "combinationHash",
          "editionNumber", "claimType", "tier", "transferable",
          "imagePath", "contentHash", "memberSlotKey"
        )
        SELECT
          ${projectId}, ${memberId}, ${[...input.traitIds]}::int[], ${input.combinationHash},
          COALESCE(MAX("editionNumber"), 0) + 1, ${rules.claimType}::"ClaimType",
          ${input.tier}::"TraitTier", ${rules.transferable},
          ${input.imagePath}, ${input.contentHash}, ${slotKey}::text
        FROM "Claim" WHERE "projectId" = ${projectId}
        RETURNING id, "editionNumber"
      `;

      return inserted[0] ?? null;
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );

  return created === null
    ? { kind: 'project-closed' }
    : { kind: 'inserted', id: created.id, editionNumber: created.editionNumber };
}
