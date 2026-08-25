import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { contentHash } from '../render/hash.js';
import { loadTraitImage } from '../render/image.js';
import type { CanvasSize } from '../render/types.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { classifyClaimConflict } from './conflict.js';
import { insertClaim } from './insert.js';

/**
 * One-of-one artwork: a bespoke piece the project awards, or a commission a
 * member ordered.
 *
 * Neither is composited, so neither has a trait combination to be identified
 * by. Their identity is the artwork itself, which is why the content hash is
 * written as the combination hash: it puts them under the same
 * (projectId, combinationHash) constraint every rolled claim obeys, so the
 * same file cannot be issued twice for exactly the reason the same combination
 * cannot be claimed twice. One promise, one index, three claim types.
 *
 * This issues a claim from artwork that already exists. It knows nothing about
 * how a commission was ordered, approved or paid for — that is Phase 12.
 */

export type OneOfOneKind = 'bespoke' | 'custom';

export interface OneOfOneRequest {
  readonly prisma: PrismaClient;
  readonly projectId: number;
  readonly canvas: CanvasSize;
  readonly memberId: number;
  readonly kind: OneOfOneKind;
  /** The finished artwork, as a path relative to `sourceRoot`. */
  readonly sourcePath: string;
  /** The artwork must resolve inside this directory. */
  readonly sourceRoot: string;
  readonly claimRoot: string;
}

export type OneOfOneOutcome =
  | {
      readonly kind: 'issued';
      /** The claim's own id. Distinct from the edition, which repeats across projects. */
      readonly claimId: number;
      readonly editionNumber: number;
      readonly imagePath: string;
      readonly contentHash: string;
    }
  /** This exact artwork is already held by somebody in this project. */
  | { readonly kind: 'artwork-taken' }
  /** Custom only: this member already holds a commission here. */
  | { readonly kind: 'member-already-holds' }
  | { readonly kind: 'project-missing' };

/**
 * Throws TraitImageError if the artwork is not a canvas-sized PNG inside the
 * root, which is deliberate: it is the very same loader and therefore the very
 * same checks the trait importer applies. Artwork that would fail to import as
 * a trait must not become a permanent claim by another door.
 */
export async function issueOneOfOne(request: OneOfOneRequest): Promise<OneOfOneOutcome> {
  const image = await loadTraitImage(request.sourcePath, {
    canvas: request.canvas,
    root: request.sourceRoot,
  });
  const digest = contentHash(image);

  const relativePath = join(String(request.projectId), `${digest}.png`);
  const absolutePath = resolve(request.claimRoot, relativePath);

  // Copied into the claim root before the insert, and harmless if the insert
  // then fails: the file is named by its own content hash, so a losing attempt
  // writes byte-identical content to the same path as the winner.
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, image);

  try {
    const inserted = await insertClaim({
      prisma: request.prisma,
      projectId: request.projectId,
      memberId: request.memberId,
      kind: request.kind,
      // A one-of-one has no combination. Inventing trait ids for it would put
      // artwork into trait supply counts that was never composited from traits.
      traitIds: [],
      combinationHash: digest,
      contentHash: digest,
      imagePath: relativePath,
      // Reserved by definition: one-of-one artwork was never in the open pool
      // and never can be. Both kinds carry the same tier so that nothing a
      // member sees distinguishes a piece the project gave them from one they
      // paid for.
      tier: 'legendary',
    });

    if (inserted.kind === 'project-closed') {
      return { kind: 'project-missing' };
    }

    return {
      kind: 'issued',
      claimId: inserted.id,
      editionNumber: inserted.editionNumber,
      imagePath: relativePath,
      contentHash: digest,
    };
  } catch (error) {
    const conflict = classifyClaimConflict(error);

    if (conflict === 'combination') {
      return { kind: 'artwork-taken' };
    }
    if (conflict === 'member') {
      return { kind: 'member-already-holds' };
    }

    // Includes the edition-number constraint, which the row lock inside
    // insertClaim should make unreachable. Issuing is rare and deliberate, so
    // a surprise here should stop and be looked at, not be smoothed over.
    throw error;
  }
}
