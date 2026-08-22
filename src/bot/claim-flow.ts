import { InputFile } from 'grammy';
import type { Api, Context } from 'grammy';
import { claimCombination } from '../claim/claim-service.js';
import type { TraitPack, TraitRecord } from '../render/types.js';
import { resolveCombination } from '../roll/cycle.js';
import type { Logger } from '../logging/logger.js';
import { confirmKeyboard, rollKeyboard } from './keyboard.js';
import { announcementText, claimConfirmPrompt, claimedReply, rollCaption } from './replies.js';
import type { RollDependencies } from './roll.js';
import type { SessionState } from './session.js';

export interface ClaimFlowDependencies extends RollDependencies {
  readonly claimRoot: string;
}

export type ConfirmationResult = 'shown' | 'stale';

export type ClaimResult =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'race-lost' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'already-claimed'; readonly editionNumber: number }
  | { readonly kind: 'closed' }
  | { readonly kind: 'stale' };

/** Swaps the rolling controls for an explicit, irreversible confirmation. */
export async function promptConfirmation(
  ctx: Context,
  session: SessionState,
  pack: TraitPack,
): Promise<ConfirmationResult> {
  const current = resolveCombination(pack, session.traitIds);
  const chatId = ctx.chat?.id;
  if (current === null || session.messageId === null || chatId === undefined) {
    return 'stale';
  }

  await ctx.api.editMessageCaption(chatId, session.messageId, {
    caption: claimConfirmPrompt(current),
    reply_markup: confirmKeyboard(),
  });
  return 'shown';
}

/** Puts the rolling controls back after a member declines to confirm. */
export async function cancelConfirmation(
  ctx: Context,
  session: SessionState,
  pack: TraitPack,
): Promise<ConfirmationResult> {
  const current = resolveCombination(pack, session.traitIds);
  const chatId = ctx.chat?.id;
  if (current === null || session.messageId === null || chatId === undefined) {
    return 'stale';
  }

  await ctx.api.editMessageCaption(chatId, session.messageId, {
    caption: rollCaption(current),
    reply_markup: rollKeyboard(pack),
  });
  return 'shown';
}

/**
 * Posts to the community group. Never throws: an announcement that cannot be
 * delivered is a cosmetic failure, and letting it surface would roll back or
 * obscure a claim that has already been committed and is permanent.
 */
async function announce(
  api: Api,
  logger: Logger,
  groupId: bigint,
  projectName: string,
  editionNumber: number,
  traits: readonly TraitRecord[],
  claimantUsername: string | null,
): Promise<void> {
  try {
    await api.sendMessage(
      Number(groupId),
      announcementText(projectName, editionNumber, traits, claimantUsername),
    );
  } catch (error) {
    logger.warn('announce.failed', {
      editionNumber,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface ClaimContext {
  readonly projectName: string;
  readonly announceOnClaim: boolean;
  readonly telegramGroupId: bigint | null;
  /** Already validated by normaliseUsername; null when the member has none. */
  readonly claimantUsername: string | null;
}

export async function performClaim(
  ctx: Context,
  deps: ClaimFlowDependencies,
  session: SessionState,
  pack: TraitPack,
  project: ClaimContext,
): Promise<ClaimResult> {
  const current = resolveCombination(pack, session.traitIds);
  const chatId = ctx.chat?.id;
  if (current === null || session.messageId === null || chatId === undefined) {
    return { kind: 'stale' };
  }

  const outcome = await claimCombination({
    prisma: deps.prisma,
    pack,
    memberId: session.memberId,
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
      const { claim } = outcome;

      // The keyboard is dropped entirely: there is nothing left to press, and
      // leaving buttons on a settled claim invites a member to try.
      await ctx.api.editMessageMedia(chatId, session.messageId, {
        type: 'photo',
        media: new InputFile(claim.image, `edition-${String(claim.editionNumber)}.png`),
        caption: claimedReply(project.projectName, claim.editionNumber, current),
      });

      // The roll is over; keeping the session would let a stale combination be
      // presented to a member who now holds something permanent.
      await deps.sessions.clear(session.memberId, session.projectId);

      deps.logger.info('claim.completed', {
        projectId: session.projectId,
        memberId: session.memberId,
        editionNumber: claim.editionNumber,
      });

      if (project.announceOnClaim && project.telegramGroupId !== null) {
        await announce(
          ctx.api,
          deps.logger,
          project.telegramGroupId,
          project.projectName,
          claim.editionNumber,
          current,
          project.claimantUsername,
        );
      }

      return { kind: 'claimed' };
    }
  }
}
