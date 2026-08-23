import { parseSolanaAddress } from './address.js';
import { consumeChallenge } from './challenge.js';
import { challengeMessage } from './message.js';
import { verifySignature } from './signature.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Logger } from '../../logging/logger.js';

/**
 * Linking a wallet to a member.
 *
 * Ownership is established by one thing only: this process verifying an
 * ed25519 signature over a message it generated, against a nonce it issued and
 * bound to one member. Nothing a browser reports is trusted, and no address is
 * ever accepted because somebody typed it.
 *
 * NEVER asks for, accepts, transmits, logs or stores a private key or seed
 * phrase. There is no code path here that could — the only secret in the flow
 * is the nonce, which this process generated itself, and the only thing that
 * ever arrives from outside is a public key and a signature.
 */

export type LinkRejection =
  /** Unknown, expired, or already used. Deliberately one answer. */
  | 'challenge-unusable'
  | 'address-invalid'
  | 'signature-invalid'
  /** The address is already proved by somebody else. */
  | 'address-taken';

export type LinkOutcome =
  | { readonly kind: 'linked'; readonly memberId: number; readonly address: string }
  | { readonly kind: 'rejected'; readonly reason: LinkRejection };

export interface CompleteLinkInput {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  /** Host the signing page was served from, as it appears in the message. */
  readonly domain: string;
  readonly token: string;
  /** Base58 public key the browser claims. Proves nothing on its own. */
  readonly claimedAddress: string;
  /** Base58 ed25519 signature over the challenge message. */
  readonly signature: string;
  readonly now?: Date;
}

/** Prisma's code for a unique violation, whichever API produced it. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'P2002';
}

export async function completeLink(input: CompleteLinkInput): Promise<LinkOutcome> {
  const { prisma, logger } = input;
  const now = input.now ?? new Date();

  // Consumed before anything is verified. If the signature turns out to be
  // wrong the challenge is spent anyway, and that is the correct trade: a
  // challenge that survives a failed attempt is a challenge somebody can
  // brute-force signatures against.
  const consumed = await consumeChallenge(prisma, input.token, now);
  if (consumed.kind === 'unusable') {
    logger.info('wallet.challenge_unusable');
    return { kind: 'rejected', reason: 'challenge-unusable' };
  }

  const { memberId, nonce, expiresAt } = consumed.challenge;
  const log = logger.child({ memberId });

  const parsed = parseSolanaAddress(input.claimedAddress);
  if (!parsed.ok) {
    log.info('wallet.address_invalid', { reason: parsed.reason });
    return { kind: 'rejected', reason: 'address-invalid' };
  }

  // Rebuilt from what the server stored, never taken from the request. If the
  // browser could supply the message text, it could supply one it already had
  // a signature for.
  const expected = challengeMessage({ domain: input.domain, nonce, expiresAt });

  const verified = verifySignature(expected, input.signature, parsed.address.bytes);
  if (!verified.ok) {
    // Logged as a reason, never with the signature or the address: this line
    // is about a failed attempt, not a record of who attempted it.
    log.warn('wallet.signature_rejected', { reason: verified.reason });
    return { kind: 'rejected', reason: 'signature-invalid' };
  }

  try {
    await prisma.member.update({
      where: { id: memberId },
      data: { walletAddress: parsed.address.base58, walletLinkedAt: now },
    });
  } catch (error) {
    // One address, one member, decided by the unique index. Without it, one
    // holder verifies once and passes the address round the community, and
    // every token gate in the product is open to everybody.
    if (isUniqueViolation(error)) {
      log.warn('wallet.address_already_linked');
      return { kind: 'rejected', reason: 'address-taken' };
    }
    throw error;
  }

  // The address is deliberately absent from this line. It is a public value on
  // chain, but tying it to a member id in a log turns the log into a
  // deanonymisation table for anybody who reads it.
  log.info('wallet.linked');
  return { kind: 'linked', memberId, address: parsed.address.base58 };
}

export interface LinkedWallet {
  readonly address: string;
  readonly linkedAt: Date;
}

/** The address a member has proved, if any. */
export async function findLinkedWallet(
  prisma: PrismaClient,
  memberId: number,
): Promise<LinkedWallet | null> {
  const row = await prisma.member.findUnique({
    where: { id: memberId },
    select: { walletAddress: true, walletLinkedAt: true },
  });

  if (row?.walletAddress == null || row.walletLinkedAt === null) {
    return null;
  }
  return { address: row.walletAddress, linkedAt: row.walletLinkedAt };
}

/**
 * Unlinks, so the address is free for its owner to link elsewhere.
 *
 * Relinking requires the same signature the first link did. There is no
 * shortcut back, and no memory of a previous link that could stand in for one.
 */
export async function unlinkWallet(prisma: PrismaClient, memberId: number): Promise<boolean> {
  const { count } = await prisma.member.updateMany({
    where: { id: memberId, walletAddress: { not: null } },
    data: { walletAddress: null, walletLinkedAt: null },
  });
  return count > 0;
}
