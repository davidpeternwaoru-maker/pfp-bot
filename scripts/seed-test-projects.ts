/**
 * Creates the projects needed to walk through every Phase 3 entry state.
 * A verification aid, not part of the product — the real thing is the admin
 * CLI in Phase 7. Idempotent: re-running updates the same four rows.
 *
 *   npm run seed:test
 */
import { loadEnv } from '../src/config/env.js';
import { createPrismaClient } from '../src/core/db/client.js';
import type { ProjectStatus } from '../src/generated/prisma/enums.js';

interface Seed {
  readonly slug: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly claimOpensAt: Date | null;
  readonly claimClosesAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const SEEDS: readonly Seed[] = [
  {
    slug: 'test-live',
    name: 'Test Live Drop',
    status: 'live',
    claimOpensAt: null,
    claimClosesAt: null,
  },
  {
    slug: 'test-draft',
    name: 'Test Draft Drop',
    status: 'draft',
    claimOpensAt: null,
    claimClosesAt: null,
  },
  {
    slug: 'test-closed',
    name: 'Test Closed Drop',
    status: 'closed',
    claimOpensAt: null,
    claimClosesAt: null,
  },
  {
    slug: 'test-early',
    name: 'Test Not Yet Open',
    status: 'live',
    claimOpensAt: new Date(Date.now() + 7 * DAY_MS),
    claimClosesAt: null,
  },
];

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);

try {
  for (const seed of SEEDS) {
    const project = await prisma.project.upsert({
      where: { slug: seed.slug },
      create: {
        slug: seed.slug,
        name: seed.name,
        mascotName: 'Tester',
        status: seed.status,
        claimOpensAt: seed.claimOpensAt,
        claimClosesAt: seed.claimClosesAt,
        canvasWidth: 512,
        canvasHeight: 512,
      },
      update: {
        name: seed.name,
        status: seed.status,
        claimOpensAt: seed.claimOpensAt,
        claimClosesAt: seed.claimClosesAt,
      },
      select: { id: true, slug: true, status: true },
    });

    process.stdout.write(
      `${project.slug.padEnd(14)} id=${String(project.id).padEnd(4)} status=${project.status}\n`,
    );
  }
} finally {
  await prisma.$disconnect();
}
