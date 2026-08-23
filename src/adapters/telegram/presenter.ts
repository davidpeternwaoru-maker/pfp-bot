import type { RolledCombination, TraitPack } from '../../core/ports.js';
import { GrammyError, InputFile } from 'grammy';
import type { Context } from 'grammy';
import type { Logger } from '../../logging/logger.js';
import { rollKeyboard } from './keyboard.js';
import { rollCaption } from './replies.js';
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
  const caption = rollCaption(combination.traits);
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
