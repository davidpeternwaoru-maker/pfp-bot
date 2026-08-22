import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildExclusionIndex, hasExcludedPair } from '../render/exclusions.js';
import { combinationHash, contentHash } from '../render/hash.js';
import { renderCombination } from '../render/image.js';
import type { TraitPack, TraitRecord } from '../render/types.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { classifyClaimConflict } from './conflict.js';
import { insertClaim } from './insert.js';

/**
 * Claiming: the one operation in the product that must never be wrong.
 *
 * Correctness rests entirely on three database constraints, not on any check
 * performed here. Anything this module tests beforehand is a courtesy that
 * produces a better message; the constraints are what make duplicates
 * impossible.
 */

export interface ClaimedRecord {
  readonly id: number;
  readonly editionNumber: number;
  readonly combinationHash: string;
  readonly contentHash: string;
  readonly imagePath: string;
  readonly traitIds: readonly number[];
  readonly image: Buffer;
}

export type ClaimOutcome =
  /** The member now holds this combination, permanently. */
  | { readonly kind: 'claimed'; readonly claim: ClaimedRecord }
  /** Somebody else took this exact combination first. Roll again. */
  | { readonly kind: 'combination-taken' }
  /** This member already holds a claim here. Show them the one they have. */
  | { readonly kind: 'member-already-claimed'; readonly editionNumber: number }
  /** The drop closed between the roll and the confirmation. */
  | { readonly kind: 'project-closed' }
  /** The combination is no longer legal — a trait was retired or excluded. */
  | { readonly kind: 'combination-invalid' };

export interface ClaimRequest {
  readonly prisma: PrismaClient;
  readonly pack: TraitPack;
  readonly memberId: number;
  readonly traits: readonly TraitRecord[];
  readonly traitRoot: string;
  readonly claimRoot: string;
}

function claimImagePath(projectId: number, hash: string): string {
  return join(String(projectId), `${hash}.png`);
}

export async function claimCombination(request: ClaimRequest): Promise<ClaimOutcome> {
  const { prisma, pack, memberId, traits } = request;

  const traitIds = traits.map((trait) => trait.id);

  // Re-checked at the last moment rather than trusted from the session: the
  // pack can change between a roll and a confirmation, and an illegal
  // combination must not become permanent.
  if (traits.length !== pack.slots.length) {
    return { kind: 'combination-invalid' };
  }
  for (const [index, slot] of pack.slots.entries()) {
    const held = traits[index];
    if (held === undefined || !slot.traits.some((option) => option.id === held.id)) {
      return { kind: 'combination-invalid' };
    }
  }
  if (hasExcludedPair(buildExclusionIndex(pack.exclusions), traitIds)) {
    return { kind: 'combination-invalid' };
  }

  const hash = combinationHash(traitIds);

  // Rendered before the transaction opens. It is the slowest step by far, and
  // doing it while holding the project's row lock would serialise every
  // concurrent claim behind one member's PNG encoder.
  const image = await renderCombination(traits, {
    canvas: pack.canvas,
    root: request.traitRoot,
  });
  const imageDigest = contentHash(image);

  const relativePath = claimImagePath(pack.projectId, hash);
  const absolutePath = resolve(request.claimRoot, relativePath);

  // Written before the insert, and safe to write even if the claim then fails:
  // the render is deterministic, so a losing claimant produces byte-identical
  // content at the same path as the winner. An orphan here is harmless, while
  // a committed claim with no artwork would not be.
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
      tier: 'open',
      asOpenClaim: true,
    });

    if (inserted.kind === 'project-closed') {
      return { kind: 'project-closed' };
    }

    return {
      kind: 'claimed',
      claim: {
        id: inserted.id,
        editionNumber: inserted.editionNumber,
        combinationHash: hash,
        contentHash: imageDigest,
        imagePath: relativePath,
        traitIds,
        image,
      },
    };
  } catch (error) {
    const conflict = classifyClaimConflict(error);

    if (conflict === 'combination') {
      return { kind: 'combination-taken' };
    }

    if (conflict === 'member') {
      const existing = await prisma.claim.findUnique({
        // Read through the same index that refused the write.
        where: {
          projectId_openClaimMemberId: { projectId: pack.projectId, openClaimMemberId: memberId },
        },
        select: { editionNumber: true },
      });
      // The constraint fired, so a row must exist; if the read still comes back
      // empty something is wrong enough that guessing would be worse.
      if (existing === null) {
        throw error;
      }
      return { kind: 'member-already-claimed', editionNumber: existing.editionNumber };
    }

    // Includes the edition-number constraint, which the row lock above should
    // make unreachable. Reaching it means the lock is not doing its job, and
    // retrying would paper over that. Rethrow, loudly.
    throw error;
  }
}
