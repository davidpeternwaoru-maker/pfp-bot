import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimCombination } from '../../src/core/claim/claim-service.js';
import type { ClaimOutcome } from '../../src/core/claim/claim-service.js';
import { createPrismaClient } from '../../src/core/db/client.js';
import { buildTraitPack } from '../../src/core/render/pack.js';
import type { TraitPack, TraitRecord } from '../../src/core/render/types.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { makeTempRoot, solidPng } from '../helpers/fixtures.js';

/**
 * The proof that the product works.
 *
 * Every other test in this suite runs against fakes. These run against a real
 * PostgreSQL, because what is under test *is* PostgreSQL: three unique
 * constraints, and whether they hold when many claims arrive at once. A fake
 * cannot fail the way a real database fails, so a fake could not prove this.
 */

// Loaded here rather than via loadEnv, which would also demand a bot token
// these tests have no use for.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
const DATABASE_URL = process.env['DATABASE_URL'];

/** Enough to interleave properly; small enough to stay a quick test. */
const CLAIMANTS = 20;

const CANVAS = { width: 32, height: 32 } as const;

let prisma: PrismaClient;
let traitRoot: string;
let claimRoot: string;
let projectId: number;
let pack: TraitPack;
let memberIds: number[];
let slug: string;

/** Distinct combinations, one per claimant. */
function combinationFor(index: number): readonly TraitRecord[] {
  const [lower, upper] = pack.slots;
  const a = lower?.traits[index % (lower.traits.length || 1)];
  const b =
    upper?.traits[Math.floor(index / (lower?.traits.length ?? 1)) % (upper?.traits.length || 1)];
  if (a === undefined || b === undefined) {
    throw new Error('pack too small for the requested combination');
  }
  return [a, b];
}

function countOf(outcomes: readonly ClaimOutcome[], kind: ClaimOutcome['kind']): number {
  return outcomes.filter((outcome) => outcome.kind === kind).length;
}

describe.skipIf(DATABASE_URL === undefined)('concurrent claiming', () => {
  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL ?? '');
    traitRoot = await makeTempRoot();
    claimRoot = await makeTempRoot();
    slug = `concurrency-${String(Date.now())}`;

    // 5 x 5 = 25 combinations, comfortably more than the 20 claimants.
    const layout = [
      { slot: 'background', layerOrder: 0, options: 5 },
      { slot: 'body', layerOrder: 10, options: 5 },
    ];

    const project = await prisma.project.create({
      data: {
        name: 'Concurrency Fixture',
        slug,
        mascotName: 'fixture',
        status: 'live',
        canvasWidth: CANVAS.width,
        canvasHeight: CANVAS.height,
      },
    });
    projectId = project.id;

    const traits: TraitRecord[] = [];
    for (const entry of layout) {
      await mkdir(join(traitRoot, entry.slot), { recursive: true });
      for (let i = 0; i < entry.options; i += 1) {
        const name = `option-${String(i + 1)}`;
        const imagePath = `${entry.slot}/${name}.png`;
        await writeFile(
          join(traitRoot, imagePath),
          await solidPng(CANVAS.width, CANVAS.height, {
            r: i * 30,
            g: entry.layerOrder,
            b: 90,
            a: 255,
          }),
        );
        const row = await prisma.trait.create({
          data: {
            projectId,
            slot: entry.slot,
            name,
            layerOrder: entry.layerOrder,
            imagePath,
            rarityWeight: 1,
            tier: 'open',
          },
          select: { id: true },
        });
        traits.push({
          id: row.id,
          slot: entry.slot,
          name,
          layerOrder: entry.layerOrder,
          imagePath,
          rarityWeight: 1,
          tier: 'open',
        });
      }
    }

    pack = buildTraitPack({ projectId, canvas: CANVAS, traits, exclusions: [] });

    const base = BigInt(Date.now()) * 1000n;
    memberIds = [];
    for (let i = 0; i < CLAIMANTS; i += 1) {
      const member = await prisma.member.create({
        data: { platform: 'telegram', externalId: String(base + BigInt(i)) },
        select: { id: true },
      });
      memberIds.push(member.id);
    }
  }, 120_000);

  afterAll(async () => {
    if (prisma === undefined) {
      return;
    }
    await prisma.claim.deleteMany({ where: { projectId } });
    await prisma.trait.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.$disconnect();
    await rm(traitRoot, { recursive: true, force: true });
    await rm(claimRoot, { recursive: true, force: true });
  }, 120_000);

  it('lets exactly one member win a contested combination', async () => {
    const contested = combinationFor(0);

    // Every claimant goes for the same artwork at the same moment.
    const outcomes = await Promise.all(
      memberIds.map((memberId) =>
        claimCombination({ prisma, pack, memberId, traits: contested, traitRoot, claimRoot }),
      ),
    );

    expect(countOf(outcomes, 'claimed')).toBe(1);
    expect(countOf(outcomes, 'combination-taken')).toBe(CLAIMANTS - 1);

    // And the database agrees: one row, not one report of one row.
    const rows = await prisma.claim.findMany({
      where: { projectId, combinationHash: { not: '' } },
      select: { memberId: true, editionNumber: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.editionNumber).toBe(1);

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('lets one member claim only once, however many attempts land together', async () => {
    const claimant = memberIds[0];
    if (claimant === undefined) {
      throw new Error('fixture did not create any members');
    }

    // One member, many different combinations, all at once.
    const outcomes = await Promise.all(
      Array.from({ length: CLAIMANTS }, (_, index) =>
        claimCombination({
          prisma,
          pack,
          memberId: claimant,
          traits: combinationFor(index),
          traitRoot,
          claimRoot,
        }),
      ),
    );

    expect(countOf(outcomes, 'claimed')).toBe(1);
    expect(countOf(outcomes, 'member-already-claimed')).toBe(CLAIMANTS - 1);

    const rows = await prisma.claim.findMany({ where: { projectId, memberId: claimant } });
    expect(rows).toHaveLength(1);

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('assigns every edition number exactly once under a simultaneous burst', async () => {
    // Different members, different combinations — every claim should succeed,
    // which makes this the real test of the edition counter.
    const outcomes = await Promise.all(
      memberIds.map((memberId, index) =>
        claimCombination({
          prisma,
          pack,
          memberId,
          traits: combinationFor(index),
          traitRoot,
          claimRoot,
        }),
      ),
    );

    expect(countOf(outcomes, 'claimed')).toBe(CLAIMANTS);

    const editions = (
      await prisma.claim.findMany({
        where: { projectId },
        select: { editionNumber: true },
        orderBy: { editionNumber: 'asc' },
      })
    ).map((row) => row.editionNumber);

    // 1..N with no gaps and no repeats. A gap would mean a wasted edition,
    // a repeat would mean "#7 of 500" identifies two different people.
    expect(editions).toEqual(Array.from({ length: CLAIMANTS }, (_, i) => i + 1));
    expect(new Set(editions).size).toBe(CLAIMANTS);

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('writes the artwork it recorded, at the path it recorded', async () => {
    const memberId = memberIds[0] ?? 0;
    const outcome = await claimCombination({
      prisma,
      pack,
      memberId,
      traits: combinationFor(3),
      traitRoot,
      claimRoot,
    });

    expect(outcome.kind).toBe('claimed');
    if (outcome.kind !== 'claimed') {
      return;
    }

    const stored = await prisma.claim.findUniqueOrThrow({
      where: { projectId_openClaimMemberId: { projectId, openClaimMemberId: memberId } },
      select: { imagePath: true, contentHash: true, combinationHash: true, traitIds: true },
    });

    expect(stored.imagePath).toBe(outcome.claim.imagePath);
    expect(stored.contentHash).toBe(outcome.claim.contentHash);
    expect(stored.combinationHash).toBe(outcome.claim.combinationHash);
    expect(stored.traitIds).toEqual([...outcome.claim.traitIds]);
    expect(existsSync(resolve(claimRoot, stored.imagePath))).toBe(true);

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);
});
