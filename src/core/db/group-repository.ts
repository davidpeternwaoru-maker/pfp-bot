import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * What a project knows about its own group.
 *
 * Two things live here: which project a group belongs to, and when each member
 * was first confirmed to be in it.
 */

export interface GroupProject {
  readonly id: number;
  readonly name: string;
  readonly eligibilityRule: unknown;
}

/**
 * The project bound to a group chat.
 *
 * Bound by announceChannelId, which is where the project already says its
 * claims are announced — so the group a project talks to is the group it
 * belongs to, and no second column has to be kept in step with the first.
 *
 * Compared as text and matched whole. The chat id arrives from an update and
 * is attacker-supplied in the sense that anybody can add the bot to a group
 * and send it a command; a project is found or it is not.
 */
export async function findProjectByGroup(
  prisma: PrismaClient,
  groupId: string,
): Promise<GroupProject | null> {
  return prisma.project.findFirst({
    where: { announceChannelId: groupId },
    select: { id: true, name: true, eligibilityRule: true },
  });
}

/**
 * Records that a member was seen in a project's group.
 *
 * `knownSince` is set once and never moved forward — an upsert that refreshed
 * it would reset everybody's tenure on every check, so nobody would ever
 * accrue any. `lastSeenAt` moves, and nothing is decided from it.
 */
export async function recordGroupMembership(
  prisma: PrismaClient,
  projectId: number,
  memberId: number,
  now: Date = new Date(),
): Promise<Date> {
  const row = await prisma.groupMembership.upsert({
    where: { projectId_memberId: { projectId, memberId } },
    create: { projectId, memberId, knownSince: now, lastSeenAt: now },
    update: { lastSeenAt: now },
    select: { knownSince: true },
  });

  return row.knownSince;
}

/** When this project first confirmed the member, or null if it never has. */
export async function findKnownSince(
  prisma: PrismaClient,
  projectId: number,
  memberId: number,
): Promise<Date | null> {
  const row = await prisma.groupMembership.findUnique({
    where: { projectId_memberId: { projectId, memberId } },
    select: { knownSince: true },
  });

  return row?.knownSince ?? null;
}

/** Forgets a member who has left, so rejoining starts their tenure again. */
export async function forgetGroupMembership(
  prisma: PrismaClient,
  projectId: number,
  memberId: number,
): Promise<void> {
  await prisma.groupMembership.deleteMany({ where: { projectId, memberId } });
}
