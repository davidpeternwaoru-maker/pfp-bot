import type { EntryExistingClaim, EntryProject } from '../bot/entry.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Exact-match lookup by slug.
 *
 * findUnique sends the slug as a bound parameter and compares it whole. There
 * is no `contains`, no `startsWith`, and no string building — an attacker-
 * supplied payload can only ever match one row or none.
 */
export async function findProjectBySlug(
  prisma: PrismaClient,
  slug: string,
): Promise<EntryProject | null> {
  return prisma.project.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      status: true,
      claimOpensAt: true,
      claimClosesAt: true,
    },
  });
}

export async function findClaimForMember(
  prisma: PrismaClient,
  projectId: number,
  memberId: number,
): Promise<EntryExistingClaim | null> {
  return prisma.claim.findUnique({
    // Reads through the same unique constraint that enforces one claim per
    // member, so this can never see more than one row.
    where: { projectId_memberId: { projectId, memberId } },
    select: { editionNumber: true },
  });
}

/**
 * Lookup by primary key, used when a button press re-checks that the drop is
 * still open. The id comes from server-side session state, never from the
 * callback payload.
 */
export async function findProjectById(
  prisma: PrismaClient,
  projectId: number,
): Promise<EntryProject | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      status: true,
      claimOpensAt: true,
      claimClosesAt: true,
    },
  });
}

export interface ClaimAnnounceSettings {
  readonly name: string;
  readonly announceOnClaim: boolean;
  readonly telegramGroupId: bigint | null;
}

/** The announcement settings needed once a claim has succeeded. */
export async function findAnnounceSettings(
  prisma: PrismaClient,
  projectId: number,
): Promise<ClaimAnnounceSettings | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, announceOnClaim: true, telegramGroupId: true },
  });
}
