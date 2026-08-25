import { issueOneOfOne } from '../claim/one-of-one-service.js';
import { transitionCommission } from './order-service.js';
import type { CanvasSize } from '../render/types.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Turning finished artwork into the claim a member ordered.
 *
 * Two things happen and they must not come apart: a custom claim is issued,
 * and the commission is marked delivered against it. Issued without the mark
 * and the member is never told; marked without the claim and they are told
 * about artwork that does not exist.
 *
 * So the claim goes first and the mark follows. That ordering is deliberate:
 * a claim with no mark is recoverable — the same file issued again is refused
 * by the content-hash constraint, and the mark can be applied by hand — while
 * a mark with no claim is a lie already delivered.
 *
 * The claim itself is an ordinary Phase 9 custom claim, which is what makes it
 * non-transferable and invisible to rarity without this module deciding either.
 */

export interface DeliveryRequest {
  readonly prisma: PrismaClient;
  readonly commissionId: number;
  readonly projectId: number;
  readonly memberId: number;
  readonly canvas: CanvasSize;
  /** The finished artwork, relative to `sourceRoot`. */
  readonly sourcePath: string;
  readonly sourceRoot: string;
  readonly claimRoot: string;
}

export type DeliveryOutcome =
  | { readonly kind: 'delivered'; readonly editionNumber: number; readonly imagePath: string }
  /** Not in production, so there is nothing to deliver. */
  | { readonly kind: 'wrong-status' }
  /** This exact artwork already belongs to somebody. */
  | { readonly kind: 'artwork-taken' }
  /** The member already holds a commissioned claim here. */
  | { readonly kind: 'member-already-holds' }
  | { readonly kind: 'project-missing' };

export async function deliverCommission(request: DeliveryRequest): Promise<DeliveryOutcome> {
  const { prisma, commissionId } = request;

  const issued = await issueOneOfOne({
    prisma,
    projectId: request.projectId,
    canvas: request.canvas,
    memberId: request.memberId,
    kind: 'custom',
    sourcePath: request.sourcePath,
    sourceRoot: request.sourceRoot,
    claimRoot: request.claimRoot,
  });

  if (issued.kind === 'artwork-taken') {
    return { kind: 'artwork-taken' };
  }
  if (issued.kind === 'member-already-holds') {
    return { kind: 'member-already-holds' };
  }
  if (issued.kind === 'project-missing') {
    return { kind: 'project-missing' };
  }

  const moved = await transitionCommission({
    prisma,
    commissionId,
    from: 'in_production',
    to: 'delivered',
    // The claim's id, not its edition number. Editions repeat across projects
    // and this column is globally unique, so the second project to deliver an
    // edition #1 would have collided with the first.
    deliveredClaimId: issued.claimId,
  });

  // The claim exists either way. Reporting the refusal rather than pretending
  // it delivered leaves an operator with a real thing to look at.
  if (moved.kind !== 'moved') {
    return { kind: 'wrong-status' };
  }

  return { kind: 'delivered', editionNumber: issued.editionNumber, imagePath: issued.imagePath };
}
