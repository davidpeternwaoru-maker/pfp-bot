/**
 * Loads a folder of PNGs into a project's trait pack so the bot has something
 * to roll. A verification aid, not the product — the real importer, with full
 * validation and clear per-file failures, is the Phase 7 admin CLI.
 *
 * Copies the artwork under TRAIT_ROOT/<slug>/ and writes one Trait row per PNG.
 * Idempotent: re-running updates the same rows.
 *
 *   npm run seed:traits -- demo-traits test-live
 */
import { cp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClient } from '../src/core/db/client.js';

const SLOT_DIR = /^(\d+)-(.+)$/;

const source = resolve(process.argv[2] ?? 'demo-traits');
const slug = process.argv[3] ?? 'test-live';

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);

const project = await prisma.project.findUnique({
  where: { slug },
  select: { id: true, name: true, canvasWidth: true, canvasHeight: true },
});

if (project === null) {
  process.stderr.write(`no project with slug "${slug}" — run npm run seed:test first\n`);
  process.exit(1);
}

// Artwork lives under TRAIT_ROOT/<slug>/ so stored paths stay relative and the
// renderer's containment check has a root to enforce.
const destination = join(resolve(env.TRAIT_ROOT), slug);
await cp(source, destination, { recursive: true });

const entries = await readdir(source, { withFileTypes: true });
let imported = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) {
    continue;
  }

  const match = SLOT_DIR.exec(entry.name);
  if (match === null) {
    process.stderr.write(`skipping "${entry.name}": not named "<layerOrder>-<slot>"\n`);
    continue;
  }

  const layerOrder = Number(match[1]);
  const slot = match[2] ?? entry.name;
  const files = (await readdir(join(source, entry.name))).filter((f) => f.endsWith('.png')).sort();

  for (const file of files) {
    const name = file.replace(/\.png$/, '');
    const imagePath = `${slug}/${entry.name}/${file}`;

    await prisma.trait.upsert({
      where: { projectId_slot_name: { projectId: project.id, slot, name } },
      create: {
        projectId: project.id,
        slot,
        name,
        layerOrder,
        imagePath,
        rarityWeight: 1,
        tier: 'open',
      },
      update: { layerOrder, imagePath },
    });
    imported += 1;
  }
}

const slots = await prisma.trait.groupBy({
  by: ['slot'],
  where: { projectId: project.id },
  _count: { _all: true },
});

const capacity = slots.reduce((total, slotGroup) => total * slotGroup._count._all, 1);

process.stdout.write(
  [
    `project    ${project.name} (${slug})`,
    `canvas     ${String(project.canvasWidth)}x${String(project.canvasHeight)}`,
    `artwork    ${destination}`,
    `traits     ${String(imported)} across ${String(slots.length)} slots`,
    `capacity   ${String(capacity)} open combinations`,
    '',
  ].join('\n'),
);

await prisma.$disconnect();
