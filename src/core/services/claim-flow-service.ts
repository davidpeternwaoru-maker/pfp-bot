import { claimCombination } from '../claim/claim-service.js';
import type { ClaimedRecord } from '../claim/claim-service.js';
import { resolveCombination } from '../roll/cycle.js';
import type { TraitPack, TraitRecord } from '../render/types.js';
import type { RollDependencies } from './roll-service.js';

/**
 * Claiming, as a product operation.
 *
 * Takes a member, a project and the combination they are holding; returns what
 * happened. The announcement, the message edit and the keyboard are all
 * somebody else's problem — this decides the outcome and nothing more.
 */

export interface ClaimFlowDependencies extends RollDependencies {
  readonly claimRoot: string;
}

export type ClaimAttempt =
  | {
      readonly kind: 'claimed';
      readonly claim: ClaimedRecord;
      readonly traits: readonly TraitRecord[];
    }
  /** Somebody took this exact combination first. Roll again and retry. */
  | { readonly kind: 'race-lost' }
  /** The combination is no longer legal — a trait was retired or excluded. */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'already-claimed'; readonly editionNumber: number }
  | { readonly kind: 'closed' }
  /** The session no longer holds a combination this pack can resolve. */
  | { readonly kind: 'stale' };

export async function attemptClaim(
  deps: ClaimFlowDependencies,
  pack: TraitPack,
  memberId: number,
  traitIds: readonly number[],
): Promise<ClaimAttempt> {
  const current = resolveCombination(pack, traitIds);
  if (current === null) {
    return { kind: 'stale' };
  }

  const outcome = await claimCombination({
    prisma: deps.prisma,
    pack,
    memberId,
    traits: current,
    traitRoot: deps.traitRoot,
    claimRoot: deps.claimRoot,
  });

  switch (outcome.kind) {
    case 'combination-taken':
      return { kind: 'race-lost' };

    case 'combination-invalid':
      return { kind: 'invalid' };

    case 'member-already-claimed':
      return { kind: 'already-claimed', editionNumber: outcome.editionNumber };

    case 'project-closed':
      return { kind: 'closed' };

    case 'claimed': {
      // The roll is over; keeping the session would let a stale combination be
      // presented to a member who now holds something permanent.
      await deps.sessions.clear(memberId, pack.projectId);

      // One combination just left the pool. Dropping the cached answer here
      // means the next member to look sees it as taken immediately, rather than
      // being shown a tick for a combination this process knows is gone.
      deps.availability.invalidate(pack.projectId);

      deps.logger.info('claim.completed', {
        projectId: pack.projectId,
        memberId,
        editionNumber: outcome.claim.editionNumber,
      });

      return { kind: 'claimed', claim: outcome.claim, traits: current };
    }
  }
}
