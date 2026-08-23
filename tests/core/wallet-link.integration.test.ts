import { existsSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../src/core/db/client.js';
import { base58Encode } from '../../src/core/wallet/base58.js';
import {
  CHALLENGE_TTL_MS,
  MAX_CHALLENGES_PER_WINDOW,
  consumeChallenge,
  findPendingChallenge,
  issueChallenge,
} from '../../src/core/wallet/challenge.js';
import {
  completeLink,
  findLinkedWallet,
  unlinkWallet,
} from '../../src/core/wallet/link-service.js';
import { challengeMessage } from '../../src/core/wallet/message.js';
import { createLogger } from '../../src/logging/logger.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { assertDatabaseResponsive } from '../helpers/database.js';

/**
 * Wallet linking against real PostgreSQL.
 *
 * Two of the three guarantees here are database guarantees and cannot be
 * tested against a fake. Single use is a conditional UPDATE, and one-address-
 * one-member is a unique index. A stub would agree with whatever the code
 * believes; only Postgres can refuse the second attempt.
 */

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
const DATABASE_URL = process.env['DATABASE_URL'];

const DOMAIN = 'pfp.example.com';

let prisma: PrismaClient;
let memberIds: number[];
let nextExternalId = BigInt(Date.now()) * 1000n;

const logger = createLogger({ level: 'error', write: () => undefined });

function keypair(): { address: string; signFor: (message: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });

  return {
    address: base58Encode(new Uint8Array(der.subarray(der.length - 32))),
    signFor: (message) =>
      base58Encode(new Uint8Array(sign(null, Buffer.from(message, 'utf8'), privateKey))),
  };
}

/**
 * A member nobody else in this file has touched.
 *
 * One per test rather than a shared pool: the rate limiter counts challenges
 * per member, so tests sharing a member would exhaust it and fail each other
 * for a reason that has nothing to do with what they assert.
 */
async function freshMember(): Promise<number> {
  nextExternalId += 1n;
  const member = await prisma.member.create({
    data: {
      platform: 'telegram',
      externalId: String(nextExternalId),
      handle: `wallet_${String(nextExternalId)}`,
    },
    select: { id: true },
  });
  memberIds.push(member.id);
  return member.id;
}

/** Issues a challenge and signs it, as an honest member's browser would. */
async function signedLink(
  memberId: number,
  wallet: ReturnType<typeof keypair>,
): Promise<{ token: string; signature: string }> {
  const issued = await issueChallenge({ prisma, memberId });
  if (issued.kind !== 'issued') {
    throw new Error('fixture could not issue a challenge');
  }
  const { token, nonce, expiresAt } = issued.challenge;
  return {
    token,
    signature: wallet.signFor(challengeMessage({ domain: DOMAIN, nonce, expiresAt })),
  };
}

describe.skipIf(DATABASE_URL === undefined)('wallet linking', () => {
  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL ?? '');
    await assertDatabaseResponsive(prisma);

    memberIds = [];
  }, 120_000);

  afterAll(async () => {
    if (prisma === undefined) {
      return;
    }
    if (memberIds !== undefined && memberIds.length > 0) {
      await prisma.walletChallenge.deleteMany({ where: { memberId: { in: memberIds } } });
      await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    }
    await prisma.$disconnect();
  }, 60_000);

  it('links a wallet whose owner signed the challenge', async () => {
    const memberId = await freshMember();
    const wallet = keypair();
    const { token, signature } = await signedLink(memberId, wallet);

    const outcome = await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token,
      claimedAddress: wallet.address,
      signature,
    });

    expect(outcome).toEqual({ kind: 'linked', memberId, address: wallet.address });
    expect((await findLinkedWallet(prisma, memberId))?.address).toBe(wallet.address);
  }, 60_000);

  it('refuses a wallet the member does not control', async () => {
    const memberId = await freshMember();
    const attacker = keypair();
    const victim = keypair();

    const issued = await issueChallenge({ prisma, memberId });
    if (issued.kind !== 'issued') {
      throw new Error('fixture could not issue a challenge');
    }
    const { token, nonce, expiresAt } = issued.challenge;

    // Signed with a wallet they do control, claiming an address they do not.
    // This is the attack the entire flow exists to stop.
    const outcome = await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token,
      claimedAddress: victim.address,
      signature: attacker.signFor(challengeMessage({ domain: DOMAIN, nonce, expiresAt })),
    });

    expect(outcome).toEqual({ kind: 'rejected', reason: 'signature-invalid' });
    expect(await findLinkedWallet(prisma, memberId)).toBeNull();
  }, 60_000);

  it('refuses a typed address with no signature behind it', async () => {
    const memberId = await freshMember();
    const wallet = keypair();
    const issued = await issueChallenge({ prisma, memberId });
    if (issued.kind !== 'issued') {
      throw new Error('fixture could not issue a challenge');
    }

    // A pasted address and a plausible-looking signature. A typed address
    // proves nothing, and there is no path that accepts one.
    const outcome = await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token: issued.challenge.token,
      claimedAddress: wallet.address,
      signature: base58Encode(new Uint8Array(64).fill(7)),
    });

    expect(outcome).toEqual({ kind: 'rejected', reason: 'signature-invalid' });
    expect(await findLinkedWallet(prisma, memberId)).toBeNull();
  }, 60_000);

  it('lets one address be linked by exactly one member', async () => {
    const first = await freshMember();
    const second = await freshMember();
    const wallet = keypair();

    const a = await signedLink(first, wallet);
    expect(
      await completeLink({
        prisma,
        logger,
        domain: DOMAIN,
        token: a.token,
        claimedAddress: wallet.address,
        signature: a.signature,
      }),
    ).toMatchObject({ kind: 'linked' });

    // The second member genuinely controls the wallet too — they have the same
    // key. Without the unique index, one holder verifies once and passes the
    // address round the community, and every token gate is open to everyone.
    const b = await signedLink(second, wallet);
    const outcome = await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token: b.token,
      claimedAddress: wallet.address,
      signature: b.signature,
    });

    expect(outcome).toEqual({ kind: 'rejected', reason: 'address-taken' });
    expect(await findLinkedWallet(prisma, second)).toBeNull();

    await unlinkWallet(prisma, first);
  }, 60_000);

  it('spends a challenge exactly once, even when two attempts race', async () => {
    const memberId = await freshMember();
    const issued = await issueChallenge({ prisma, memberId });
    if (issued.kind !== 'issued') {
      throw new Error('fixture could not issue a challenge');
    }
    const { token } = issued.challenge;

    // Both arrive together, as a captured request replayed alongside the real
    // one would. The conditional UPDATE is what makes exactly one of them win.
    const [left, right] = await Promise.all([
      consumeChallenge(prisma, token),
      consumeChallenge(prisma, token),
    ]);

    const consumed = [left, right].filter((result) => result.kind === 'consumed');
    expect(consumed).toHaveLength(1);

    // And it stays spent afterwards.
    expect((await consumeChallenge(prisma, token)).kind).toBe('unusable');
  }, 60_000);

  it('refuses a replayed signature, because the challenge is already spent', async () => {
    const memberId = await freshMember();
    const wallet = keypair();
    const { token, signature } = await signedLink(memberId, wallet);

    const first = await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token,
      claimedAddress: wallet.address,
      signature,
    });
    expect(first.kind).toBe('linked');

    // The exact same request again — a captured one, replayed.
    const replay = await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token,
      claimedAddress: wallet.address,
      signature,
    });
    expect(replay).toEqual({ kind: 'rejected', reason: 'challenge-unusable' });

    await unlinkWallet(prisma, memberId);
  }, 60_000);

  it('spends the challenge even when the signature was wrong', async () => {
    const memberId = await freshMember();
    const wallet = keypair();
    const issued = await issueChallenge({ prisma, memberId });
    if (issued.kind !== 'issued') {
      throw new Error('fixture could not issue a challenge');
    }
    const { token } = issued.challenge;

    await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token,
      claimedAddress: wallet.address,
      signature: base58Encode(new Uint8Array(64).fill(3)),
    });

    // A challenge that survived a failed attempt is a challenge somebody can
    // grind signatures against.
    expect((await consumeChallenge(prisma, token)).kind).toBe('unusable');
  }, 60_000);

  it('refuses an expired challenge', async () => {
    const memberId = await freshMember();
    const wallet = keypair();

    const past = new Date(Date.now() - CHALLENGE_TTL_MS - 60_000);
    const issued = await issueChallenge({ prisma, memberId, now: past });
    if (issued.kind !== 'issued') {
      throw new Error('fixture could not issue a challenge');
    }
    const { token, nonce, expiresAt } = issued.challenge;

    expect(await findPendingChallenge(prisma, token)).toBeNull();

    const outcome = await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token,
      claimedAddress: wallet.address,
      signature: wallet.signFor(challengeMessage({ domain: DOMAIN, nonce, expiresAt })),
    });

    expect(outcome).toEqual({ kind: 'rejected', reason: 'challenge-unusable' });
  }, 60_000);

  it('refuses an unknown token the same way it refuses a spent one', async () => {
    const outcome = await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token: 'a-token-that-was-never-issued',
      claimedAddress: keypair().address,
      signature: base58Encode(new Uint8Array(64)),
    });

    // One answer for unknown, spent and expired. Distinguishing them would
    // confirm that a token exists to whoever guessed it.
    expect(outcome).toEqual({ kind: 'rejected', reason: 'challenge-unusable' });
  }, 60_000);

  it('will not verify a signature collected for another site', async () => {
    const memberId = await freshMember();
    const wallet = keypair();
    const issued = await issueChallenge({ prisma, memberId });
    if (issued.kind !== 'issued') {
      throw new Error('fixture could not issue a challenge');
    }
    const { token, nonce, expiresAt } = issued.challenge;

    // A phishing page on another domain collects a real signature over its own
    // message. The domain is inside the signed text, so it does not transfer.
    const elsewhere = challengeMessage({ domain: 'evil.example.com', nonce, expiresAt });

    const outcome = await completeLink({
      prisma,
      logger,
      domain: DOMAIN,
      token,
      claimedAddress: wallet.address,
      signature: wallet.signFor(elsewhere),
    });

    expect(outcome).toEqual({ kind: 'rejected', reason: 'signature-invalid' });
  }, 60_000);

  it('allows unlink and relink, with the same proof required again', async () => {
    const memberId = await freshMember();
    const wallet = keypair();

    const first = await signedLink(memberId, wallet);
    expect(
      await completeLink({
        prisma,
        logger,
        domain: DOMAIN,
        token: first.token,
        claimedAddress: wallet.address,
        signature: first.signature,
      }),
    ).toMatchObject({ kind: 'linked' });

    expect(await unlinkWallet(prisma, memberId)).toBe(true);
    expect(await findLinkedWallet(prisma, memberId)).toBeNull();
    // Nothing remembers the previous link, so nothing can stand in for a proof.
    expect(await unlinkWallet(prisma, memberId)).toBe(false);

    const again = await signedLink(memberId, wallet);
    expect(
      await completeLink({
        prisma,
        logger,
        domain: DOMAIN,
        token: again.token,
        claimedAddress: wallet.address,
        signature: again.signature,
      }),
    ).toMatchObject({ kind: 'linked' });

    await unlinkWallet(prisma, memberId);
  }, 60_000);

  it('rate limits how fast one member may start challenges', async () => {
    const memberId = await freshMember();

    for (let i = 0; i < MAX_CHALLENGES_PER_WINDOW; i += 1) {
      expect((await issueChallenge({ prisma, memberId })).kind).toBe('issued');
    }

    const blocked = await issueChallenge({ prisma, memberId });
    expect(blocked.kind).toBe('rate-limited');
    if (blocked.kind === 'rate-limited') {
      // Names when, rather than leaving them to guess.
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
  }, 60_000);
});
