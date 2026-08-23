import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimCombination } from '../../src/core/claim/claim-service.js';
import { issueOneOfOne } from '../../src/core/claim/one-of-one-service.js';
import { createPrismaClient } from '../../src/core/db/client.js';
import { findStatsClaims, loadClaimedHashes } from '../../src/core/db/claim-repository.js';
import { findClaimForMember } from '../../src/core/db/project-repository.js';
import { buildTraitPack } from '../../src/core/render/pack.js';
import { projectStats } from '../../src/core/stats.js';
import type { TraitPack, TraitRecord } from '../../src/core/render/types.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { makeTempRoot, publishedFigures, solidPng } from '../helpers/fixtures.js';
import { assertDatabaseResponsive } from '../helpers/database.js';

/**
 * The claim taxonomy against real PostgreSQL.
 *
 * What separates the three claim types is which unique index each one is
 * subject to, and an index is not something application code can be trusted to
 * describe. A fake would happily agree that a member holds one open claim and
 * one commission; only Postgres can refuse the second of either.
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

/** Distinct one-of-one artwork, written where an operator would put it. */
async function artwork(name: string, shade: number): Promise<string> {
  const path = `one-of-one/${name}.png`;
  await mkdir(join(traitRoot, 'one-of-one'), { recursive: true });
  await writeFile(
    join(traitRoot, path),
    await solidPng(CANVAS.width, CANVAS.height, { r: shade, g: 5, b: 200, a: 255 }),
  );
  return path;
}

function combination(index: number): readonly TraitRecord[] {
  const [lower, upper] = pack.slots;
  const a = lower?.traits[index % 3];
  const b = upper?.traits[Math.floor(index / 3) % 3];
  if (a === undefined || b === undefined) {
    throw new Error('fixture pack too small');
  }
  return [a, b];
}

describe.skipIf(DATABASE_URL === undefined)('claim taxonomy', () => {
  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL ?? '');
    await assertDatabaseResponsive(prisma);

    traitRoot = await makeTempRoot();
    claimRoot = await makeTempRoot();

    const project = await prisma.project.create({
      data: {
        name: 'Taxonomy Fixture',
        slug: `taxonomy-${String(Date.now())}`,
        mascotName: 'fixture',
        status: 'live',
        canvasWidth: CANVAS.width,
        canvasHeight: CANVAS.height,
      },
      select: { id: true },
    });
    projectId = project.id;

    const traits: TraitRecord[] = [];
    for (const [slot, layerOrder] of [
      ['background', 0],
      ['body', 10],
    ] as const) {
      await mkdir(join(traitRoot, slot), { recursive: true });
      for (let index = 0; index < 3; index += 1) {
        const name = `option-${String(index)}`;
        const imagePath = `${slot}/${name}.png`;
        await writeFile(
          join(traitRoot, imagePath),
          await solidPng(CANVAS.width, CANVAS.height, { r: index * 60, g: 40, b: 90, a: 255 }),
        );
        const row = await prisma.trait.create({
          data: { projectId, slot, name, layerOrder, imagePath, rarityWeight: 1, tier: 'open' },
          select: { id: true },
        });
        traits.push({
          id: row.id,
          slot,
          name,
          layerOrder,
          imagePath,
          rarityWeight: 1,
          tier: 'open',
        });
      }
    }

    pack = buildTraitPack({ projectId, canvas: CANVAS, traits, exclusions: [] });

    const base = BigInt(Date.now()) * 1000n;
    memberIds = [];
    for (let i = 0; i < 3; i += 1) {
      const member = await prisma.member.create({
        data: {
          platform: 'telegram',
          externalId: String(base + BigInt(i)),
          handle: `taxonomy_${String(i)}`,
        },
        select: { id: true },
      });
      memberIds.push(member.id);
    }
  }, 120_000);

  afterAll(async () => {
    if (prisma === undefined) {
      return;
    }
    if (projectId !== undefined) {
      await prisma.claim.deleteMany({ where: { projectId } });
      await prisma.trait.deleteMany({ where: { projectId } });
      await prisma.project.deleteMany({ where: { id: projectId } });
    }
    if (memberIds !== undefined && memberIds.length > 0) {
      await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    }
    await prisma.$disconnect();
    for (const root of [traitRoot, claimRoot]) {
      if (root !== undefined) {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('lets one member hold an open claim and a commission, but never two of either', async () => {
    const memberId = memberIds[0] ?? 0;

    const rolled = await claimCombination({
      prisma,
      pack,
      memberId,
      traits: combination(0),
      traitRoot,
      claimRoot,
    });
    expect(rolled.kind).toBe('claimed');

    // The commission does not collide with the open claim: the two occupy
    // different slots, which is the whole reason the key encodes the slot.
    const commissioned = await issueOneOfOne({
      prisma,
      projectId,
      canvas: CANVAS,
      memberId,
      kind: 'custom',
      sourcePath: await artwork('commission-a', 11),
      sourceRoot: traitRoot,
      claimRoot,
    });
    expect(commissioned.kind).toBe('issued');

    // A second of each is refused by the index, not by a check that could race.
    const secondRoll = await claimCombination({
      prisma,
      pack,
      memberId,
      traits: combination(1),
      traitRoot,
      claimRoot,
    });
    expect(secondRoll.kind).toBe('member-already-claimed');

    const secondCommission = await issueOneOfOne({
      prisma,
      projectId,
      canvas: CANVAS,
      memberId,
      kind: 'custom',
      sourcePath: await artwork('commission-b', 22),
      sourceRoot: traitRoot,
      claimRoot,
    });
    expect(secondCommission.kind).toBe('member-already-holds');

    // And the entry lookup still finds the rolled claim, not the commission.
    const held = await findClaimForMember(prisma, projectId, memberId);
    expect(held?.editionNumber).toBe(1);

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('records the taxonomy on the row itself, so nothing downstream has to infer it', async () => {
    const memberId = memberIds[1] ?? 0;

    await claimCombination({
      prisma,
      pack,
      memberId,
      traits: combination(2),
      traitRoot,
      claimRoot,
    });
    await issueOneOfOne({
      prisma,
      projectId,
      canvas: CANVAS,
      memberId,
      kind: 'custom',
      sourcePath: await artwork('commission-c', 33),
      sourceRoot: traitRoot,
      claimRoot,
    });
    await issueOneOfOne({
      prisma,
      projectId,
      canvas: CANVAS,
      memberId: memberIds[2] ?? 0,
      kind: 'bespoke',
      sourcePath: await artwork('bespoke-a', 44),
      sourceRoot: traitRoot,
      claimRoot,
    });

    const rows = await prisma.claim.findMany({
      where: { projectId },
      orderBy: { editionNumber: 'asc' },
      select: { claimType: true, transferable: true, traitIds: true, memberSlotKey: true },
    });

    expect(rows.map((row) => row.claimType)).toEqual(['open', 'custom', 'bespoke']);
    // Only a commission is non-transferable, and only insertClaim decides that.
    expect(rows.map((row) => row.transferable)).toEqual([true, false, true]);
    // claimType is `open` exactly when the claim has a trait combination.
    expect(rows.map((row) => row.traitIds.length > 0)).toEqual([true, false, false]);
    // A bespoke piece occupies no member slot, so it never blocks anything.
    expect(rows[2]?.memberSlotKey).toBeNull();

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('refuses the same one-of-one artwork twice, under the same index as a duplicate roll', async () => {
    const file = await artwork('bespoke-shared', 55);

    const first = await issueOneOfOne({
      prisma,
      projectId,
      canvas: CANVAS,
      memberId: memberIds[0] ?? 0,
      kind: 'bespoke',
      sourcePath: file,
      sourceRoot: traitRoot,
      claimRoot,
    });
    expect(first.kind).toBe('issued');

    // A different member, the same bytes. Two people holding one image is the
    // duplicate this product cannot ship, whatever produced the image.
    const second = await issueOneOfOne({
      prisma,
      projectId,
      canvas: CANVAS,
      memberId: memberIds[1] ?? 0,
      kind: 'bespoke',
      sourcePath: file,
      sourceRoot: traitRoot,
      claimRoot,
    });
    expect(second.kind).toBe('artwork-taken');

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);

  it('keeps commissions out of the rolling pool and out of the rarity report', async () => {
    const rolled = await claimCombination({
      prisma,
      pack,
      memberId: memberIds[0] ?? 0,
      traits: combination(4),
      traitRoot,
      claimRoot,
    });
    expect(rolled.kind).toBe('claimed');

    const hashesBefore = await loadClaimedHashes(prisma, projectId);
    const statsBefore = projectStats(await findStatsClaims(prisma, projectId), pack);

    await issueOneOfOne({
      prisma,
      projectId,
      canvas: CANVAS,
      memberId: memberIds[1] ?? 0,
      kind: 'custom',
      sourcePath: await artwork('commission-d', 66),
      sourceRoot: traitRoot,
      claimRoot,
    });

    const hashesAfter = await loadClaimedHashes(prisma, projectId);
    const statsAfter = projectStats(await findStatsClaims(prisma, projectId), pack);

    // The taken-combination set is what a roller is measured against. A
    // commission has no combination, so it must not appear in it.
    expect([...hashesAfter]).toEqual([...hashesBefore]);
    expect(hashesAfter.size).toBe(1);

    // And every published figure is untouched. Only the commission counter,
    // which is reported separately and counted in nothing, moves.
    expect(publishedFigures(statsAfter)).toEqual(publishedFigures(statsBefore));
    expect(statsAfter.customClaims).toBe(1);

    await prisma.claim.deleteMany({ where: { projectId } });
  }, 120_000);
});
