import type { PrismaClient } from '../generated/prisma/client.js';
import type { TraitTier } from '../render/types.js';

/**
 * The one place a Claim row is written.
 *
 * Both the open-pool path and the award path go through here so the edition
 * counter and the open-claim marker cannot drift apart between them. Conflicts
 * are not handled here: they are thrown so each caller can say what the
 * collision means to the person who caused it.
 */

export interface InsertClaimInput {
  readonly prisma: PrismaClient;
  readonly projectId: number;
  readonly memberId: number;
  readonly traitIds: readonly number[];
  readonly combinationHash: string;
  readonly contentHash: string;
  readonly imagePath: string;
  readonly tier: TraitTier;
  /**
   * False for awards. An award is a deliberate act by an operator, so it is
   * allowed alongside a member's open claim and outside the claim window.
   */
  readonly asOpenClaim: boolean;
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
  const { prisma, projectId, memberId, asOpenClaim } = input;

  const created = await prisma.$transaction(
    async (tx) => {
      // Locks the project row for the rest of the transaction, so concurrent
      // claims on this project queue rather than interleave. Without it, two
      // claims read the same MAX(editionNumber) and both try to use it.
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;

      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { status: true, claimClosesAt: true },
      });

      if (project === null) {
        return null;
      }

      // Fail closed for members. Awards skip this deliberately: an operator
      // handing out a legendary after a drop closes is the normal case.
      if (asOpenClaim) {
        if (project.status !== 'live') {
          return null;
        }
        if (project.claimClosesAt !== null && new Date() >= project.claimClosesAt) {
          return null;
        }
      }

      const rows = await tx.$queryRaw<{ max: number | null }[]>`
        SELECT MAX("editionNumber")::int AS max FROM "Claim" WHERE "projectId" = ${projectId}
      `;
      const editionNumber = (rows[0]?.max ?? 0) + 1;

      return tx.claim.create({
        data: {
          projectId,
          memberId,
          traitIds: [...input.traitIds],
          combinationHash: input.combinationHash,
          editionNumber,
          tier: input.tier,
          imagePath: input.imagePath,
          contentHash: input.contentHash,
          // The marker that scopes the unique index to open claims. Null here
          // is what lets a member hold awards alongside their open one.
          openClaimMemberId: asOpenClaim ? memberId : null,
        },
        select: { id: true, editionNumber: true },
      });
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );

  return created === null
    ? { kind: 'project-closed' }
    : { kind: 'inserted', id: created.id, editionNumber: created.editionNumber };
}
