import type { PrismaClient } from '../../generated/prisma/client.js';
import type { StatsClaim } from '../stats.js';
import type { TraitTier } from '../render/types.js';

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
 *
 * Restricted to open-type claims because only they have a trait combination to
 * be taken. A bespoke or custom claim stores the hash of its own image bytes,
 * which is a different kind of value in the same column and can never equal a
 * combination hash — including them could only ever be noise in the set that
 * decides what a member is allowed to roll.
 */
export async function loadClaimedHashes(
  prisma: PrismaClient,
  projectId: number,
): Promise<ReadonlySet<string>> {
  const rows = await prisma.claim.findMany({
    where: { projectId, claimType: 'open' },
    select: { combinationHash: true },
  });

  return new Set(rows.map((row) => row.combinationHash));
}

export interface MemberClaim {
  readonly editionNumber: number;
  readonly traitIds: readonly number[];
  readonly imagePath: string;
  readonly claimedAt: Date;
  readonly tier: TraitTier;
  readonly projectName: string;
}

/**
 * Every claim a member holds in one project.
 *
 * Plural because a member can hold their open claim and any number of awarded
 * ones. Ordered by edition so the list reads the way the collection was built.
 */
export async function findMemberClaims(
  prisma: PrismaClient,
  projectId: number,
  memberId: number,
): Promise<readonly MemberClaim[]> {
  const rows = await prisma.claim.findMany({
    where: { projectId, memberId },
    orderBy: { editionNumber: 'asc' },
    select: {
      editionNumber: true,
      traitIds: true,
      imagePath: true,
      claimedAt: true,
      tier: true,
      project: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    editionNumber: row.editionNumber,
    traitIds: row.traitIds,
    imagePath: row.imagePath,
    claimedAt: row.claimedAt,
    tier: row.tier,
    projectName: row.project.name,
  }));
}

export interface CollectionEntry {
  readonly projectSlug: string;
  readonly projectName: string;
  readonly editionNumber: number;
  readonly tier: TraitTier;
  readonly claimedAt: Date;
}

/**
 * Every claim a member holds, across every project.
 *
 * Ordered newest first: the thing someone just claimed is what they opened the
 * command to see.
 */
export async function findCollection(
  prisma: PrismaClient,
  memberId: number,
): Promise<readonly CollectionEntry[]> {
  const rows = await prisma.claim.findMany({
    where: { memberId },
    orderBy: { claimedAt: 'desc' },
    select: {
      editionNumber: true,
      tier: true,
      claimedAt: true,
      project: { select: { name: true, slug: true } },
    },
  });

  return rows.map((row) => ({
    projectSlug: row.project.slug,
    projectName: row.project.name,
    editionNumber: row.editionNumber,
    tier: row.tier,
    claimedAt: row.claimedAt,
  }));
}

/**
 * Everything the rarity report counts from, in one read.
 *
 * Custom claims are fetched rather than filtered out here on purpose: the
 * exclusion rule belongs to projectStats, where it is pure and can be proved
 * by running it twice. A repository that quietly dropped rows would make that
 * rule untestable and invisible.
 */
export async function findStatsClaims(
  prisma: PrismaClient,
  projectId: number,
): Promise<readonly StatsClaim[]> {
  return prisma.claim.findMany({
    where: { projectId },
    select: { traitIds: true, claimType: true, tier: true, claimedAt: true },
  });
}
