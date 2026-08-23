import type { BrowseView, RolledCombination, TraitPack } from '../../core/ports.js';
import { GrammyError, InputFile } from 'grammy';
import type { Context } from 'grammy';
import type { Logger } from '../../logging/logger.js';
import { browseKeyboard, rollKeyboard } from './keyboard.js';
import { browseCaption, rollCaption } from './replies.js';
import type { MessageBindingStore } from './message-binding.js';

/**
 * Puts a combination on screen and keeps it on one message.
 *
 * This is the whole of what Telegram adds to a roll: core decides *what* the
 * member should see, and this decides *where* it goes. The first call sends a
 * photo; every later one edits that same message. A chat that fills with a new
 * image per button press is unusable on a phone.
 */

export interface PresenterDependencies {
  readonly bindings: MessageBindingStore;
  readonly logger: Logger;
}

export async function showCombination(
  ctx: Context,
  deps: PresenterDependencies,
  pack: TraitPack,
  memberId: number,
  combination: RolledCombination,
): Promise<void> {
  const caption = rollCaption(combination.traits, combination.available);
  const keyboard = rollKeyboard(pack);
  const media = (): InputFile => new InputFile(combination.image, 'roll.png');

  const sendFresh = async (): Promise<void> => {
    const sent = await ctx.replyWithPhoto(media(), { caption, reply_markup: keyboard });
    await deps.bindings.bind(memberId, pack.projectId, sent.message_id);
  };

  const bound = await deps.bindings.messageFor(memberId, pack.projectId);
  const chatId = ctx.chat?.id;

  if (bound === undefined || chatId === undefined) {
    await sendFresh();
    return;
  }

  try {
    await ctx.api.editMessageMedia(
      chatId,
      bound,
      { type: 'photo', media: media(), caption },
      { reply_markup: keyboard },
    );
  } catch (error) {
    // The message may have been deleted by the member. Recovering with a fresh
    // one keeps them rolling; failing here would strand them with dead buttons.
    if (!(error instanceof GrammyError)) {
      throw error;
    }
    deps.logger.info('roll.edit_failed', {
      memberId,
      projectId: pack.projectId,
      reason: error.description,
    });
    await sendFresh();
  }
}

/**
 * Swaps the rolling controls for a slot's option list, on the same message.
 *
 * The artwork stays exactly where it is and only the caption and buttons
 * change. Sending a second message for the list would leave a member scrolling
 * between the picture and the picker, and editing the photo would make opening
 * a list cost a re-upload of an image that has not changed.
 */
export async function showBrowse(
  ctx: Context,
  deps: PresenterDependencies,
  projectId: number,
  memberId: number,
  view: BrowseView,
): Promise<'shown' | 'stale'> {
  const messageId = await deps.bindings.messageFor(memberId, projectId);
  const chatId = ctx.chat?.id;
  if (messageId === undefined || chatId === undefined) {
    return 'stale';
  }

  try {
    await ctx.api.editMessageCaption(chatId, messageId, {
      caption: browseCaption(view),
      reply_markup: browseKeyboard(view),
    });
    return 'shown';
  } catch (error) {
    // The member may have deleted the message. Reported as stale so the caller
    // starts them again rather than leaving them tapping dead buttons.
    if (!(error instanceof GrammyError)) {
      throw error;
    }
    deps.logger.info('browse.edit_failed', { memberId, projectId, reason: error.description });
    return 'stale';
  }
}
