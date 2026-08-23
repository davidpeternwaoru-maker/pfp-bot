import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * The one-time challenge behind a wallet link.
 *
 * Single use is enforced by the database, not by reading a row and deciding.
 * A read-then-write here is a race: two requests arriving together both see an
 * unconsumed challenge, both verify the same captured signature, and the replay
 * this whole mechanism exists to prevent happens anyway. So consuming is one
 * conditional UPDATE, and whether it matched a row is the answer.
 *
 * Rows are kept after use. `consumedAt` is what makes a replay detectable, and
 * a deleted row is indistinguishable from one that never existed.
 */

/** 256 bits, so neither value is worth guessing at. */
const TOKEN_BYTES = 32;
const NONCE_BYTES = 32;

/**
 * Five minutes, as the plan specifies. Long enough to open a link, find a
 * wallet and read the message; short enough that a token seen over somebody's
 * shoulder is stale before it is useful.
 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * How many challenges one member may start in the window.
 *
 * Rate limited per member rather than per address: the address is not known
 * until the signature arrives, so anything keyed on it is keyed on a value the
 * attacker chooses.
 */
export const MAX_CHALLENGES_PER_WINDOW = 5;
export const CHALLENGE_WINDOW_MS = 10 * 60 * 1000;

export interface IssuedChallenge {
  /** Goes in the signing page URL. Never the member id. */
  readonly token: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

export type IssueResult =
  | { readonly kind: 'issued'; readonly challenge: IssuedChallenge }
  /** Too many starts too fast. Names when they may try again. */
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number };

/** URL-safe, and no base58 confusion: these are never read aloud or typed. */
function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

export interface IssueChallengeInput {
  readonly prisma: PrismaClient;
  readonly memberId: number;
  readonly now?: Date;
}

export async function issueChallenge(input: IssueChallengeInput): Promise<IssueResult> {
  const { prisma, memberId } = input;
  const now = input.now ?? new Date();

  const windowStart = new Date(now.getTime() - CHALLENGE_WINDOW_MS);
  const recent = await prisma.walletChallenge.count({
    where: { memberId, createdAt: { gte: windowStart } },
  });

  if (recent >= MAX_CHALLENGES_PER_WINDOW) {
    const oldest = await prisma.walletChallenge.findFirst({
      where: { memberId, createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const freeAt = (oldest?.createdAt.getTime() ?? now.getTime()) + CHALLENGE_WINDOW_MS;
    return {
      kind: 'rate-limited',
      retryAfterSeconds: Math.max(1, Math.ceil((freeAt - now.getTime()) / 1000)),
    };
  }

  const challenge: IssuedChallenge = {
    token: randomToken(TOKEN_BYTES),
    nonce: randomToken(NONCE_BYTES),
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  };

  await prisma.walletChallenge.create({
    data: {
      memberId,
      token: challenge.token,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    },
  });

  return { kind: 'issued', challenge };
}

export interface PendingChallenge {
  readonly memberId: number;
  readonly nonce: string;
  readonly expiresAt: Date;
}

/**
 * Looks a challenge up for display, without consuming it.
 *
 * Used only to render the signing page. It deliberately returns nothing that
 * identifies the member to the browser — the caller gets the member id so it
 * can bind the verification, and the page is given the nonce and nothing else.
 */
export async function findPendingChallenge(
  prisma: PrismaClient,
  token: string,
  now: Date = new Date(),
): Promise<PendingChallenge | null> {
  const row = await prisma.walletChallenge.findUnique({
    where: { token },
    select: { memberId: true, nonce: true, expiresAt: true, consumedAt: true },
  });

  if (row === null || row.consumedAt !== null || row.expiresAt <= now) {
    return null;
  }

  return { memberId: row.memberId, nonce: row.nonce, expiresAt: row.expiresAt };
}

export type ConsumeResult =
  | { readonly kind: 'consumed'; readonly challenge: PendingChallenge }
  /** Unknown token, already used, or expired. All three are one refusal. */
  | { readonly kind: 'unusable' };

/**
 * Claims a challenge, atomically, and returns what it was bound to.
 *
 * The WHERE clause carries every precondition — not consumed, not expired —
 * so the database decides whether this caller is the one that gets it. Two
 * simultaneous attempts on the same token therefore produce exactly one
 * 'consumed' and one 'unusable', which is what makes a replayed signature
 * useless rather than merely unlikely.
 *
 * The three failure modes collapse into one answer on purpose. Telling the
 * caller which of them applied would confirm that a token exists, and that is
 * information the person holding a guessed token has not earned.
 */
export async function consumeChallenge(
  prisma: PrismaClient,
  token: string,
  now: Date = new Date(),
): Promise<ConsumeResult> {
  const rows = await prisma.$queryRaw<
    { memberId: number; nonce: string; expiresAt: Date }[]
  >`UPDATE "WalletChallenge"
      SET "consumedAt" = ${now}
    WHERE "token" = ${token}
      AND "consumedAt" IS NULL
      AND "expiresAt" > ${now}
    RETURNING "memberId", "nonce", "expiresAt"`;

  const row = rows[0];
  return row === undefined ? { kind: 'unusable' } : { kind: 'consumed', challenge: row };
}

/**
 * Deletes challenges that are long past useful.
 *
 * Kept well beyond expiry rather than swept at it: a consumed row is the
 * evidence that a token was already used, and deleting it promptly would turn
 * a detectable replay back into an unknown token.
 */
export async function pruneChallenges(
  prisma: PrismaClient,
  olderThan: Date = new Date(Date.now() - 24 * 60 * 60 * 1000),
): Promise<number> {
  const { count } = await prisma.walletChallenge.deleteMany({
    where: { expiresAt: { lt: olderThan } },
  });
  return count;
}
