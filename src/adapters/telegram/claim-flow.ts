import type { ClaimedRecord, TraitPack, TraitRecord } from '../../core/ports.js';
import { InputFile } from 'grammy';
import type { Api, Context } from 'grammy';
import type { Logger } from '../../logging/logger.js';
import { confirmKeyboard, rollKeyboard } from './keyboard.js';
import { announcementText, claimConfirmPrompt, claimedReply, rollCaption } from './replies.js';
import type { MessageBindingStore } from './message-binding.js';

/**
 * How claiming looks in Telegram.
 *
 * The decision itself — whether a claim succeeds, who won a contested
 * combination, what edition number it gets — lives in core. Everything here is
 * presentation: which message to edit, which buttons to show, what to post to
 * the group.
 */

export type ConfirmationResult = 'shown' | 'stale';

/** Swaps the rolling controls for an explicit, irreversible confirmation. */
export async function promptConfirmation(
  ctx: Context,
  bindings: MessageBindingStore,
  memberId: number,
  pack: TraitPack,
  traits: readonly TraitRecord[],
): Promise<ConfirmationResult> {
  const messageId = await bindings.messageFor(memberId, pack.projectId);
  const chatId = ctx.chat?.id;
  if (messageId === undefined || chatId === undefined) {
    return 'stale';
  }

  await ctx.api.editMessageCaption(chatId, messageId, {
    caption: claimConfirmPrompt(traits),
    reply_markup: confirmKeyboard(),
  });
  return 'shown';
}

/** Puts the rolling controls back after a member declines to confirm. */
export async function cancelConfirmation(
  ctx: Context,
  bindings: MessageBindingStore,
  memberId: number,
  pack: TraitPack,
  traits: readonly TraitRecord[],
): Promise<ConfirmationResult> {
  const messageId = await bindings.messageFor(memberId, pack.projectId);
  const chatId = ctx.chat?.id;
  if (messageId === undefined || chatId === undefined) {
    return 'stale';
  }

  await ctx.api.editMessageCaption(chatId, messageId, {
    caption: rollCaption(traits),
    reply_markup: rollKeyboard(pack),
  });
  return 'shown';
}

/** Replaces the roll with the settled claim, and drops the keyboard. */
export async function showClaimed(
  ctx: Context,
  bindings: MessageBindingStore,
  memberId: number,
  pack: TraitPack,
  projectName: string,
  claim: ClaimedRecord,
  traits: readonly TraitRecord[],
): Promise<void> {
  const messageId = await bindings.messageFor(memberId, pack.projectId);
  const chatId = ctx.chat?.id;
  const caption = claimedReply(projectName, claim.editionNumber, traits);
  const media = new InputFile(claim.image, `edition-${String(claim.editionNumber)}.png`);

  if (messageId === undefined || chatId === undefined) {
    await ctx.replyWithPhoto(media, { caption });
    return;
  }

  // The keyboard is dropped entirely: there is nothing left to press, and
  // leaving buttons on a settled claim invites a member to try.
  await ctx.api.editMessageMedia(chatId, messageId, { type: 'photo', media, caption });

  // The roll is over, so the message is no longer showing one.
  await bindings.release(memberId, pack.projectId);
}

/**
 * Posts to the community group. Never throws: an announcement that cannot be
 * delivered is a cosmetic failure, and letting it surface would obscure a claim
 * that has already been committed and is permanent.
 */
export async function announceClaim(
  api: Api,
  logger: Logger,
  /** Opaque to core; Telegram reads it as a numeric chat id. */
  channelId: string,
  projectName: string,
  editionNumber: number,
  traits: readonly TraitRecord[],
  claimantUsername: string | null,
): Promise<void> {
  const chatId = Number(channelId);
  if (!Number.isFinite(chatId)) {
    // Configured for a different front end, or mistyped. Not this adapter's
    // announcement to make, and never a reason to disturb a settled claim.
    logger.warn('announce.channel_not_telegram', { editionNumber });
    return;
  }

  try {
    await api.sendMessage(
      chatId,
      announcementText(projectName, editionNumber, traits, claimantUsername),
    );
  } catch (error) {
    logger.warn('announce.failed', {
      editionNumber,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
