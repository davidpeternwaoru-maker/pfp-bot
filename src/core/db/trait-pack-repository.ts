import { buildTraitPack } from '../render/pack.js';
import { TraitPackError } from '../render/errors.js';
import type { TraitPack } from '../render/types.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Loads a project's trait pack from the database.
 *
 * The only database-aware part of the render engine: it turns rows into plain
 * records and hands them to the pure builder, which does the validating.
 */
export async function fetchTraitPack(prisma: PrismaClient, projectId: number): Promise<TraitPack> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, canvasWidth: true, canvasHeight: true },
  });

  if (project === null) {
    throw new TraitPackError(`project ${String(projectId)} does not exist`);
  }

  const [traits, exclusions] = await Promise.all([
    prisma.trait.findMany({
      where: { projectId },
      // Ordered here as well as in the builder so the rows arrive in a stable
      // order; the builder still sorts, since ordering is a render invariant.
      orderBy: [{ layerOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        slot: true,
        name: true,
        layerOrder: true,
        imagePath: true,
        rarityWeight: true,
        tier: true,
      },
    }),
    prisma.exclusion.findMany({
      where: { projectId },
      select: { traitAId: true, traitBId: true },
    }),
  ]);

  return buildTraitPack({
    projectId: project.id,
    canvas: { width: project.canvasWidth, height: project.canvasHeight },
    traits,
    exclusions,
  });
}
