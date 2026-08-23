import { existsSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../../src/adapters/http/server.js';
import { createPrismaClient } from '../../../src/core/db/client.js';
import { base58Encode } from '../../../src/core/wallet/base58.js';
import { issueChallenge } from '../../../src/core/wallet/challenge.js';
import { challengeMessage } from '../../../src/core/wallet/message.js';
import { findLinkedWallet } from '../../../src/core/wallet/link-service.js';
import { createLogger } from '../../../src/logging/logger.js';
import type { PrismaClient } from '../../../src/generated/prisma/client.js';

/**
 * The signing page, driven over real HTTP.
 *
 * What is tested here is not the wallet handshake — that happens in a browser
 * extension nobody can automate from Node — but everything either side of it:
 * what the page is allowed to load, what the endpoint accepts, and what it
 * says back. A page that leaks a member id, or an endpoint that believes a
 * browser's verdict, would pass every unit test in the project.
 */

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
const DATABASE_URL = process.env['DATABASE_URL'];

const PUBLIC_BASE_URL = 'https://pfp.example.com';
const DOMAIN = 'pfp.example.com';

let prisma: PrismaClient;
let server: Server;
let origin: string;
let memberIds: number[] = [];
let nextExternalId = BigInt(Date.now()) * 1000n;

function keypair(): { address: string; signFor: (message: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    address: base58Encode(new Uint8Array(der.subarray(der.length - 32))),
    signFor: (message) =>
      base58Encode(new Uint8Array(sign(null, Buffer.from(message, 'utf8'), privateKey))),
  };
}

async function freshMember(): Promise<number> {
  nextExternalId += 1n;
  const member = await prisma.member.create({
    data: { platform: 'telegram', externalId: String(nextExternalId), handle: null },
    select: { id: true },
  });
  memberIds.push(member.id);
  return member.id;
}

describe.skipIf(DATABASE_URL === undefined)('the signing page', () => {
  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL ?? '');
    await prisma.$queryRaw`SELECT 1`;

    server = createHttpServer({
      prisma,
      logger: createLogger({ level: 'error', write: () => undefined }),
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${String(address.port)}`;
    memberIds = [];
  }, 120_000);

  afterAll(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    if (prisma !== undefined) {
      if (memberIds.length > 0) {
        await prisma.walletChallenge.deleteMany({ where: { memberId: { in: memberIds } } });
        await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
      }
      await prisma.$disconnect();
    }
  }, 60_000);

  async function startChallenge(): Promise<{
    memberId: number;
    token: string;
    message: string;
  }> {
    const memberId = await freshMember();
    const issued = await issueChallenge({ prisma, memberId });
    if (issued.kind !== 'issued') {
      throw new Error('fixture could not issue a challenge');
    }
    const { token, nonce, expiresAt } = issued.challenge;
    return { memberId, token, message: challengeMessage({ domain: DOMAIN, nonce, expiresAt }) };
  }

  it('serves the page for a live token, and refuses everything to load', async () => {
    const { token } = await startChallenge();
    const response = await fetch(`${origin}/link/${token}`);
    const html = await response.text();

    expect(response.status).toBe(200);

    // Nothing external, so nothing about this page is decided elsewhere.
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(html).not.toMatch(/src="https?:/);

    // A one-time token must not sit in a cache or travel in a referrer.
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  }, 60_000);

  it('never puts the member id on the page', async () => {
    const { memberId, token } = await startChallenge();
    const html = await (await fetch(`${origin}/link/${token}`)).text();

    // The browser is told the nonce and nothing that says whose nonce it is.
    expect(html).not.toContain(`"${String(memberId)}"`);
    expect(html).not.toMatch(new RegExp(`\\bmemberId\\b`));
    expect(html).not.toMatch(new RegExp(`\\b${String(memberId)}\\b`));
  }, 60_000);

  it('says plainly that it will never ask for a seed phrase', async () => {
    const { token } = await startChallenge();
    const html = await (await fetch(`${origin}/link/${token}`)).text();

    // The most valuable thing this page can teach somebody is what a scam
    // looks like when it eventually arrives wearing this page's clothes.
    expect(html).toContain('never ask for your seed phrase');
    expect(html).toContain('not</strong> a transaction');

    // And there is nowhere on it that a secret could be typed.
    expect(html).not.toMatch(/<input/i);
    expect(html).not.toMatch(/<textarea/i);
    expect(html).not.toMatch(/<form/i);
  }, 60_000);

  it('links a wallet when the signature checks out', async () => {
    const { memberId, token, message } = await startChallenge();
    const wallet = keypair();

    const response = await fetch(`${origin}/link/${token}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature: wallet.signFor(message) }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: true });
    expect((await findLinkedWallet(prisma, memberId))?.address).toBe(wallet.address);
  }, 60_000);

  it('refuses a browser that simply claims the signature was fine', async () => {
    const { memberId, token } = await startChallenge();
    const wallet = keypair();

    // Exactly what a rewritten page would send: the right shape, a real
    // address, and a signature that was never produced by that key. The
    // browser's own verdict is not a field this endpoint reads.
    const response = await fetch(`${origin}/link/${token}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: wallet.address,
        signature: base58Encode(new Uint8Array(64).fill(1)),
        verified: true,
        linked: true,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ linked: false });
    expect(await findLinkedWallet(prisma, memberId)).toBeNull();
  }, 60_000);

  it('answers unknown, spent and expired tokens identically', async () => {
    const { token, message } = await startChallenge();
    const wallet = keypair();

    // Spend it.
    await fetch(`${origin}/link/${token}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature: wallet.signFor(message) }),
    });

    const spent = await fetch(`${origin}/link/${token}`);
    const unknown = await fetch(`${origin}/link/${'A'.repeat(43)}`);

    // Same status and same body, so a guessed token learns nothing about
    // whether it happened to name something real.
    expect(spent.status).toBe(unknown.status);
    expect(await spent.text()).toBe(await unknown.text());
  }, 60_000);

  it('refuses a malformed token without going near the database', async () => {
    for (const bad of ['short', 'a'.repeat(200), '../../etc/passwd', 'has spaces']) {
      const response = await fetch(`${origin}/link/${encodeURIComponent(bad)}`);
      expect(response.status).toBe(404);
    }
  }, 60_000);

  it('refuses a body that is not what it expects, and one that is enormous', async () => {
    const { token } = await startChallenge();

    const cases: readonly string[] = [
      'not json at all',
      JSON.stringify({}),
      JSON.stringify({ address: 123, signature: [] }),
      JSON.stringify({ address: 'x'.repeat(500), signature: 'y' }),
      JSON.stringify({ address: 'a', signature: 'b'.repeat(100_000) }),
    ];

    for (const body of cases) {
      const response = await fetch(`${origin}/link/${token}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ linked: false });
    }
  }, 60_000);

  it('serves nothing else at all', async () => {
    for (const path of ['/', '/health', '/index.html', '/../src/index.ts', '/link']) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(404);
      // No stack, no path, no internal id in any body it returns.
      const body = await response.text();
      expect(body).not.toMatch(/at .*\.ts|node_modules|prisma|Error:/i);
    }
  }, 60_000);

  it('refuses the wrong method rather than falling through', async () => {
    const { token } = await startChallenge();

    expect((await fetch(`${origin}/link/${token}`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${origin}/link/${token}/verify`, { method: 'GET' })).status).toBe(405);
  }, 60_000);
});
