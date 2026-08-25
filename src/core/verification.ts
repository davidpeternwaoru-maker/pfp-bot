import type { PrismaClient } from '../generated/prisma/client.js';
import type { TraitTier } from './render/types.js';

/**
 * Answering "does this person hold one, and which".
 *
 * Public by design: it runs in a project's group where anybody can read the
 * answer, which is the point — a community verifying its own holders needs no
 * operator in the loop.
 *
 * Public also decides what it may say. The select below is the whole
 * protection: a wallet address is never read, so there is no path by which one
 * reaches a group chat. That is deliberately enforced by what is fetched
 * rather than by what is formatted — a formatter can be edited by somebody who
 * does not know why, and a column that was never selected cannot be printed by
 * accident.
 */

export interface VerifiedClaim {
  readonly editionNumber: number;
  readonly tier: TraitTier;
  readonly claimedAt: Date;
}

export type VerificationOutcome =
  | { readonly kind: 'holds'; readonly handle: string; readonly claims: readonly VerifiedClaim[] }
  /** Known to the bot, holds nothing here. */
  | { readonly kind: 'holds-none'; readonly handle: string }
  /** Never used the bot at all, which is not the same as holding nothing. */
  | { readonly kind: 'unknown-member'; readonly handle: string };

/**
 * What a member holds in one project.
 *
 * Custom claims are included. A commission is as much theirs as anything
 * rolled, and hiding it here would make the command say somebody holds nothing
 * while they are wearing the artwork — access and rarity are separate
 * concerns, and so are access and this.
 */
export async function verifyHolder(
  prisma: PrismaClient,
  projectId: number,
  platform: 'telegram' | 'discord' | 'web',
  handle: string,
): Promise<VerificationOutcome> {
  const member = await prisma.member.findFirst({
    where: { platform, handle },
    // Only the id. Not the wallet, not the external id — nothing this command
    // has any business putting in front of a group.
    select: { id: true },
  });

  if (member === null) {
    return { kind: 'unknown-member', handle };
  }

  const claims = await prisma.claim.findMany({
    where: { projectId, memberId: member.id },
    orderBy: { editionNumber: 'asc' },
    select: { editionNumber: true, tier: true, claimedAt: true },
  });

  return claims.length === 0 ? { kind: 'holds-none', handle } : { kind: 'holds', handle, claims };
}
