/**
 * Measures how a burst of simultaneous claims behaves: throughput, and how it
 * fails when it fails.
 *
 * Claims on one project serialise on that project's row lock, so the ceiling
 * is set by how long each transaction holds it — which is network round trips
 * to the database, not CPU. That makes this worth measuring against the real
 * database rather than reasoning about.
 *
 *   npm run bench:claims -- 40
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { loadEnv } from '../src/config/env.js';
import { claimCombination } from '../src/claim/claim-service.js';
import { createPrismaClient } from '../src/db/client.js';
import { buildTraitPack } from '../src/render/pack.js';
import type { TraitRecord } from '../src/render/types.js';

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const N = Number(process.argv[2] ?? '20');

const traitRoot = await mkdtemp(join(tmpdir(), 'bench-traits-'));
const claimRoot = await mkdtemp(join(tmpdir(), 'bench-claims-'));

const project = await prisma.project.create({
  data: {
    name: 'Bench',
    slug: `bench-${String(Date.now())}`,
    mascotName: 'b',
    status: 'live',
    canvasWidth: 32,
    canvasHeight: 32,
  },
});

const traits: TraitRecord[] = [];
for (const [slot, layerOrder] of [
  ['a', 0],
  ['b', 10],
] as const) {
  await mkdir(join(traitRoot, slot), { recursive: true });
  for (let i = 0; i < 10; i += 1) {
    const imagePath = `${slot}/${String(i)}.png`;
    await writeFile(
      join(traitRoot, imagePath),
      await sharp({
        create: {
          width: 32,
          height: 32,
          channels: 4,
          background: { r: i * 30, g: 20, b: 60, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    const row = await prisma.trait.create({
      data: {
        projectId: project.id,
        slot,
        name: `o${String(i)}`,
        layerOrder,
        imagePath,
        rarityWeight: 1,
        tier: 'open',
      },
      select: { id: true },
    });
    traits.push({
      id: row.id,
      slot,
      name: `o${String(i)}`,
      layerOrder,
      imagePath,
      rarityWeight: 1,
      tier: 'open',
    });
  }
}

const pack = buildTraitPack({
  projectId: project.id,
  canvas: { width: 32, height: 32 },
  traits,
  exclusions: [],
});
const base = BigInt(Date.now()) * 1000n;
const memberIds: number[] = [];
for (let i = 0; i < N; i += 1) {
  const m = await prisma.member.create({
    data: { telegramUserId: base + BigInt(i) },
    select: { id: true },
  });
  memberIds.push(m.id);
}

const slotA = pack.slots[0]?.traits ?? [];
const slotB = pack.slots[1]?.traits ?? [];

const started = Date.now();
const results = await Promise.allSettled(
  memberIds.map((memberId, i) => {
    const a = slotA[i % slotA.length];
    const b = slotB[Math.floor(i / slotA.length) % slotB.length];
    if (a === undefined || b === undefined) throw new Error('pack too small');
    return claimCombination({ prisma, pack, memberId, traits: [a, b], traitRoot, claimRoot });
  }),
);
const elapsed = Date.now() - started;

let claimed = 0;
const problems = new Map<string, number>();
for (const r of results) {
  if (r.status === 'rejected') {
    const msg =
      r.reason instanceof Error ? (r.reason.message.split('\n')[0] ?? 'error') : String(r.reason);
    problems.set(msg.slice(0, 80), (problems.get(msg.slice(0, 80)) ?? 0) + 1);
  } else if (r.value.kind === 'claimed') {
    claimed += 1;
  } else {
    problems.set(r.value.kind, (problems.get(r.value.kind) ?? 0) + 1);
  }
}

process.stdout.write(`claimants        ${String(N)}\n`);
process.stdout.write(
  `wall time        ${String(elapsed)} ms  (${String(Math.round(elapsed / N))} ms per claim)\n`,
);
process.stdout.write(`claimed          ${String(claimed)}\n`);
for (const [reason, count] of problems) process.stdout.write(`  ${String(count)}x ${reason}\n`);

await prisma.claim.deleteMany({ where: { projectId: project.id } });
await prisma.trait.deleteMany({ where: { projectId: project.id } });
await prisma.project.delete({ where: { id: project.id } });
await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
await prisma.$disconnect();
await rm(traitRoot, { recursive: true, force: true });
await rm(claimRoot, { recursive: true, force: true });
