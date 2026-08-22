import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderCombination } from '../render/image.js';
import { resolveCombination } from '../roll/cycle.js';
import type { TraitPack } from '../render/types.js';

/**
 * The stored artwork for a claim, re-rendered if the file is missing.
 *
 * The database row is the record of a claim; the PNG beside it is a cache.
 * Because the render is deterministic, a lost or never-written file can always
 * be rebuilt from the trait ids, so a missing file must never mean a member
 * cannot get their own artwork back.
 */
export async function loadClaimArtwork(
  claimRoot: string,
  traitRoot: string,
  imagePath: string,
  pack: TraitPack,
  traitIds: readonly number[],
): Promise<Buffer | null> {
  try {
    return await readFile(resolve(claimRoot, imagePath));
  } catch {
    const traits = resolveCombination(pack, traitIds);
    if (traits === null) {
      return null;
    }
    return renderCombination(traits, { canvas: pack.canvas, root: traitRoot });
  }
}
