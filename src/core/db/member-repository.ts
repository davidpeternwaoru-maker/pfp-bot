import type { PrismaClient } from '../../generated/prisma/client.js';

export interface MemberRef {
  readonly id: number;
}

/**
 * Finds or creates the member behind a Telegram user id.
 *
 * Only the id and the handle are stored — no display name, no photo, no
 * language, nothing else Telegram happens to send. The username is written on
 * every entry because people change theirs, and a stale one is worse than none.
 */
export async function resolveMember(
  prisma: PrismaClient,
  telegramUserId: bigint,
  username: string | null,
): Promise<MemberRef> {
  const member = await prisma.member.upsert({
    where: { telegramUserId },
    create: { telegramUserId, username },
    update: { username },
    select: { id: true },
  });

  return member;
}
