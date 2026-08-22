import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awardCombination } from '../../src/core/claim/award-service.js';
import { claimCombination } from '../../src/core/claim/claim-service.js';
import { createPrismaClient } from '../../src/core/db/client.js';
import { findCollection } from '../../src/core/db/claim-repository.js';
import { buildTraitPack } from '../../src/core/render/pack.js';
import type { TraitPack, TraitRecord } from '../../src/core/render/types.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { makeTempRoot, solidPng } from '../helpers/fixtures.js';

/**
 * Awards against real PostgreSQL.
 *
 * The whole point of an award is which constraints it does and does not
 * escape, and that is decided by indexes, not by application code. Faking the
 * database here would test nothing.
 */

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
const DATABASE_URL = process.env['DATABASE_URL'];

const CANVAS = { width: 32, height: 32 } as const;

let prisma: PrismaClient;
let traitRoot: string;
let claimRoot: string;
let projectId: number;
let pack: TraitPack;
let memberIds: number[];

/** open/open/legendary in slot one, open/legendary in slot two. */
const LAYOUT = [
  { slot: 'background', layerOrder: 0, tiers: ['open', 'open', 'legendary'] as const },
  { slot: 'body', layerOrder: 10, tiers: ['open', 'legendary'] as const },
];

function traitBy(slot: string, index: number): TraitRecord {
  const found = pack.slots.find((s) => s.slot === slot)?.traits[index];
  if (found === undefined) {
    throw new Error(`fixture missing ${slot}[${String(index)}]`);
  }
  return found;
}

describe.skipIf(DATABASE_URL === undefined)('awarding a legendary', () => {
  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL ?? '');
    traitRoot = await makeTempRoot();
    claimRoot = await makeTempRoot();

    const project = await prisma.project.create({
      data: {
        name: 'Award Fixture',
        slug: `award-${String(Date.now())}`,
        mascotName: 'fixture',
        status: 'live',
        canvasWidth: CANVAS.width,
        canvasHeight: CANVAS.height,
      },
    });
    projectId = project.id;

    const traits: TraitRecord[] = [];
    for (const entry of LAYOUT) {
      await mkdir(join(traitRoot, entry.slot), { recursive: true });
      for (const [index, tier] of entry.tiers.entries()) {
        const name = `${tier}-${String(index)}`;
        const imagePath = `${entry.slot}/${name}.png`;
        await writeFile(
          join(traitRoot, imagePath),
          await solidPng(CANVAS.width, CANVAS.height, { r: index * 60, g: 40, b: 90, a: 255 }),
        );
        const row = await prisma.trait.create({
          data: {
            projectId,
            slot: entry.slot,
            name,
            layerOrder: entry.layerOrder,
            imagePath,
            rarityWeight: 1,
            tier,
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
          tier,
        });
      }
    }

    pack = buildTraitPack({ projectId, canvas: CANVAS, traits, exclusions: [] });

    const base = BigInt(Date.now()) * 1000n;
    memberIds = [];
    for (let i = 0; i < 3; i += 1) {
      const member = await prisma.member.create({
        data: { telegramUserId: base + BigInt(i), username: `awardee_${String(i)}` },
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

  it('sits alongside a member’s open claim rather than blocking it', async () => {
    const member = memberIds[0] ?? 0;

    const rolled = await claimCombination({
      prisma,
      pack,
      memberId: member,
      traits: [traitBy('background', 0), traitBy('body', 0)],
      traitRoot,
      claimRoot,
    });
    expect(rolled.kind).toBe('claimed');

    // The award must succeed even though this member already holds an open one.
    const awarded = await awardCombination({
      prisma,
      pack,
      memberId: member,
      traitIds: [traitBy('background', 2).id, traitBy('body', 0).id],
      traitRoot,
      claimRoot,
    });
    expect(awarded.kind).toBe('awarded');

    const held = await prisma.claim.findMany({ where: { projectId, memberId: member } });
    expect(held).toHaveLength(2);

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('still refuses to duplicate a combination somebody holds', async () => {
    const first = await awardCombination({
      prisma,
      pack,
      memberId: memberIds[0] ?? 0,
      traitIds: [traitBy('background', 2).id, traitBy('body', 0).id],
      traitRoot,
      claimRoot,
    });
    expect(first.kind).toBe('awarded');

    // Same combination, different recipient. Uniqueness is not negotiable.
    const second = await awardCombination({
      prisma,
      pack,
      memberId: memberIds[1] ?? 0,
      traitIds: [traitBy('background', 2).id, traitBy('body', 0).id],
      traitRoot,
      claimRoot,
    });
    expect(second.kind).toBe('combination-taken');

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('still refuses a second open claim from the same member', async () => {
    const member = memberIds[0] ?? 0;

    const first = await claimCombination({
      prisma,
      pack,
      memberId: member,
      traits: [traitBy('background', 0), traitBy('body', 0)],
      traitRoot,
      claimRoot,
    });
    expect(first.kind).toBe('claimed');

    // The scoped index must still hold; this is the regression that matters.
    const second = await claimCombination({
      prisma,
      pack,
      memberId: member,
      traits: [traitBy('background', 1), traitBy('body', 0)],
      traitRoot,
      claimRoot,
    });
    expect(second.kind).toBe('member-already-claimed');

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('lets one member hold more than one award', async () => {
    const member = memberIds[0] ?? 0;

    const a = await awardCombination({
      prisma,
      pack,
      memberId: member,
      traitIds: [traitBy('background', 2).id, traitBy('body', 0).id],
      traitRoot,
      claimRoot,
    });
    const b = await awardCombination({
      prisma,
      pack,
      memberId: member,
      traitIds: [traitBy('background', 0).id, traitBy('body', 1).id],
      traitRoot,
      claimRoot,
    });

    expect(a.kind).toBe('awarded');
    expect(b.kind).toBe('awarded');

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('refuses an all-open combination, which should be rolled instead', async () => {
    const outcome = await awardCombination({
      prisma,
      pack,
      memberId: memberIds[0] ?? 0,
      traitIds: [traitBy('background', 0).id, traitBy('body', 0).id],
      traitRoot,
      claimRoot,
    });
    expect(outcome.kind).toBe('not-reserved');
  }, 120_000);

  it('refuses an incomplete or overfilled combination without writing anything', async () => {
    const missing = await awardCombination({
      prisma,
      pack,
      memberId: memberIds[0] ?? 0,
      traitIds: [traitBy('background', 2).id],
      traitRoot,
      claimRoot,
    });
    expect(missing.kind).toBe('invalid-combination');

    const doubled = await awardCombination({
      prisma,
      pack,
      memberId: memberIds[0] ?? 0,
      traitIds: [traitBy('background', 2).id, traitBy('background', 0).id, traitBy('body', 0).id],
      traitRoot,
      claimRoot,
    });
    expect(doubled.kind).toBe('invalid-combination');

    expect(await prisma.claim.count({ where: { projectId } })).toBe(0);
  }, 120_000);

  it('shows awards and rolled claims together in the collection', async () => {
    const member = memberIds[0] ?? 0;

    await claimCombination({
      prisma,
      pack,
      memberId: member,
      traits: [traitBy('background', 0), traitBy('body', 0)],
      traitRoot,
      claimRoot,
    });
    await awardCombination({
      prisma,
      pack,
      memberId: member,
      traitIds: [traitBy('background', 2).id, traitBy('body', 1).id],
      traitRoot,
      claimRoot,
    });

    const collection = await findCollection(prisma, member);
    expect(collection).toHaveLength(2);
    expect(collection.map((entry) => entry.tier).sort()).toEqual(['legendary', 'open']);

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);
});
