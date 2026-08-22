import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Platform } from '../../generated/prisma/enums.js';

export interface MemberRef {
  readonly id: number;
}

/**
 * Who a member is, in terms any front end can supply.
 *
 * The platform's own id rather than a Telegram user id: a Discord snowflake, a
 * web account id and a Telegram id all arrive here the same way, and nothing
 * downstream has to know which produced this row.
 */
export interface MemberIdentity {
  readonly platform: Platform;
  /** The platform's own id for this person. */
  readonly externalId: string;
  /** Display handle on that platform, already validated by the adapter. */
  readonly handle: string | null;
}

/**
 * Finds or creates the member behind an identity.
 *
 * Only the identity and the handle are stored — no display name, no photo, no
 * language, nothing else a front end happens to send. The handle is written on
 * every entry because people change theirs, and a stale one is worse than none.
 */
export async function resolveMember(
  prisma: PrismaClient,
  identity: MemberIdentity,
): Promise<MemberRef> {
  const { platform, externalId, handle } = identity;

  return prisma.member.upsert({
    where: { platform_externalId: { platform, externalId } },
    create: { platform, externalId, handle },
    update: { handle },
    select: { id: true },
  });
}

/** Looks up an existing member by identity, without creating one. */
export async function findMemberByIdentity(
  prisma: PrismaClient,
  platform: Platform,
  externalId: string,
): Promise<MemberRef | null> {
  return prisma.member.findUnique({
    where: { platform_externalId: { platform, externalId } },
    select: { id: true },
  });
}

export interface MemberProfile extends MemberRef {
  readonly externalId: string;
  readonly handle: string | null;
}

/**
 * Looks up a member by the handle they use on a platform.
 *
 * Handles are not unique and change freely, so this can only ever be a
 * convenience for an operator typing a name — never an identity check.
 */
export async function findMemberByHandle(
  prisma: PrismaClient,
  platform: Platform,
  handle: string,
): Promise<MemberProfile | null> {
  return prisma.member.findFirst({
    where: { platform, handle },
    select: { id: true, externalId: true, handle: true },
  });
}
