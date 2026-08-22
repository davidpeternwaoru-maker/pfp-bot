import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { combinationHash, contentHash } from '../render/hash.js';
import { renderCombination } from '../render/image.js';
import type { TraitPack, TraitRecord } from '../render/types.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { classifyClaimConflict } from './conflict.js';
import { insertClaim } from './insert.js';

/**
 * Hand-awarded claims, for legendary artwork that is never in the open pool.
 *
 * An award deliberately ignores the rules a rolled claim obeys — rarity
 * weights, exclusions, the claim window, and the one-open-claim-per-member
 * limit — because it is an operator placing a specific piece with a specific
 * person. The one rule it cannot ignore is combination uniqueness: an award
 * that duplicated a held combination would break the same promise a duplicate
 * roll would.
 */

export type AwardOutcome =
  | {
      readonly kind: 'awarded';
      readonly editionNumber: number;
      readonly imagePath: string;
      readonly image: Buffer;
    }
  /** Somebody already holds this exact combination. */
  | { readonly kind: 'combination-taken' }
  /** The traits do not form one complete combination for this pack. */
  | { readonly kind: 'invalid-combination'; readonly reason: string }
  /** None of the named traits is reserved, so this should be a roll. */
  | { readonly kind: 'not-reserved' }
  | { readonly kind: 'project-missing' };

export interface AwardRequest {
  readonly prisma: PrismaClient;
  readonly pack: TraitPack;
  readonly memberId: number;
  readonly traitIds: readonly number[];
  readonly traitRoot: string;
  readonly claimRoot: string;
}

/**
 * Resolves ids into exactly one trait per slot, in layer order.
 * Rejects rather than guesses: a wrong award is permanent.
 */
function resolveAwardTraits(
  pack: TraitPack,
  traitIds: readonly number[],
): { readonly traits: readonly TraitRecord[] } | { readonly reason: string } {
  const unique = new Set(traitIds);
  if (unique.size !== traitIds.length) {
    return { reason: 'the same trait was listed twice' };
  }

  const traits: TraitRecord[] = [];
  const remaining = new Set(traitIds);

  for (const slot of pack.slots) {
    const matches = slot.traits.filter((trait) => remaining.has(trait.id));
    if (matches.length === 0) {
      return { reason: `no trait given for slot "${slot.slot}"` };
    }
    if (matches.length > 1) {
      return { reason: `more than one trait given for slot "${slot.slot}"` };
    }
    const chosen = matches[0];
    if (chosen === undefined) {
      return { reason: `no trait given for slot "${slot.slot}"` };
    }
    traits.push(chosen);
    remaining.delete(chosen.id);
  }

  if (remaining.size > 0) {
    return { reason: 'some traits do not belong to this project' };
  }

  return { traits };
}

export async function awardCombination(request: AwardRequest): Promise<AwardOutcome> {
  const { prisma, pack, memberId } = request;

  const resolved = resolveAwardTraits(pack, request.traitIds);
  if ('reason' in resolved) {
    return { kind: 'invalid-combination', reason: resolved.reason };
  }

  const { traits } = resolved;

  // An award is for reserved artwork. If every trait is open-tier this is just
  // a roll, and routing it through the award path would quietly hand somebody
  // a second open-pool claim.
  if (!traits.some((trait) => trait.tier !== 'open')) {
    return { kind: 'not-reserved' };
  }

  const traitIds = traits.map((trait) => trait.id);
  const hash = combinationHash(traitIds);

  const image = await renderCombination(traits, {
    canvas: pack.canvas,
    root: request.traitRoot,
  });
  const imageDigest = contentHash(image);

  const relativePath = join(String(pack.projectId), `${hash}.png`);
  const absolutePath = resolve(request.claimRoot, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, image);

  try {
    const inserted = await insertClaim({
      prisma,
      projectId: pack.projectId,
      memberId,
      traitIds,
      combinationHash: hash,
      contentHash: imageDigest,
      imagePath: relativePath,
      // The claim's tier is the highest reserved tier it contains, so a
      // collection listing can say what kind of thing it is.
      tier: traits.some((trait) => trait.tier === 'legendary') ? 'legendary' : 'gated',
      asOpenClaim: false,
    });

    if (inserted.kind === 'project-closed') {
      return { kind: 'project-missing' };
    }

    return {
      kind: 'awarded',
      editionNumber: inserted.editionNumber,
      imagePath: relativePath,
      image,
    };
  } catch (error) {
    if (classifyClaimConflict(error) === 'combination') {
      return { kind: 'combination-taken' };
    }
    // Anything else is unexpected. An award is rare and deliberate, so a
    // surprise here should stop and be looked at, not be smoothed over.
    throw error;
  }
}
