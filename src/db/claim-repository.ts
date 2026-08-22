import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Every combination hash already claimed in a project.
 *
 * Loaded per interaction rather than cached: a stale set would hand a member a
 * combination somebody else has just taken, and they would only find out when
 * the claim failed. The database is the authority on what is taken, and this
 * read must not drift from it.
 *
 * This is a scan of one project's claims. At pilot scale that is a few hundred
 * short rows; if a drop ever gets large enough for it to matter, the fix is an
 * existence check per candidate hash rather than a cache.
 */
export async function loadClaimedHashes(
  prisma: PrismaClient,
  projectId: number,
): Promise<ReadonlySet<string>> {
  const rows = await prisma.claim.findMany({
    where: { projectId },
    select: { combinationHash: true },
  });

  return new Set(rows.map((row) => row.combinationHash));
}

export interface MemberClaim {
  readonly editionNumber: number;
  readonly traitIds: readonly number[];
  readonly imagePath: string;
  readonly claimedAt: Date;
  readonly projectName: string;
}

/**
 * Reads through the one-claim-per-member constraint, so this can never see
 * more than one row however the data got there.
 */
export async function findMemberClaim(
  prisma: PrismaClient,
  projectId: number,
  memberId: number,
): Promise<MemberClaim | null> {
  const row = await prisma.claim.findUnique({
    where: { projectId_memberId: { projectId, memberId } },
    select: {
      editionNumber: true,
      traitIds: true,
      imagePath: true,
      claimedAt: true,
      project: { select: { name: true } },
    },
  });

  if (row === null) {
    return null;
  }

  return {
    editionNumber: row.editionNumber,
    traitIds: row.traitIds,
    imagePath: row.imagePath,
    claimedAt: row.claimedAt,
    projectName: row.project.name,
  };
}
