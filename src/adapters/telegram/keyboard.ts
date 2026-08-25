import type { BrowseView, CommissionStatus, Prompt, TraitPack } from '../../core/ports.js';
import { DECLINE_REASONS } from '../../core/ports.js';
import { InlineKeyboard } from 'grammy';
import { DECLINE_LABELS } from './commission-replies.js';
import {
  browseAction,
  browsePageAction,
  CANCEL_CLAIM,
  CLAIM,
  CLOSE_BROWSE,
  CONFIRM_CLAIM,
  optionAction,
  REROLL,
  slotAction,
  WALLET_LINK,
  COMMISSION_ABANDON,
  COMMISSION_ORDER,
  COMMISSION_SKIP,
  COMMISSION_WAITLIST,
  commissionColourAction,
  commissionSlotAction,
  QUEUE_APPROVE,
  QUEUE_PAID,
  QUEUE_BACK,
  QUEUE_DECLINE,
  QUEUE_NEXT,
  QUEUE_PRODUCE,
  queueReasonAction,
} from './callback-data.js';

/** Beyond this, button labels start truncating on a narrow phone. */
const OPTION_LABEL_LIMIT = 18;

/** Two option buttons abreast is the most that stays readable at that width. */
const OPTIONS_PER_ROW = 2;

/**
 * How many page buttons are offered directly.
 *
 * Direct page buttons are what keep a large slot shallow: with them, any option
 * in a forty-option slot is three taps away — open the list, pick the page,
 * pick the option — instead of a run of "next" presses proportional to how far
 * down it sits. Past this many pages there is no room for them on one row, so
 * the arrows take over and the list is deep again; that is the point at which a
 * slot is too large to browse comfortably and wants splitting.
 */
const MAX_DIRECT_PAGES = 6;

/** Names come from an admin import, so they are trimmed before display. */
function label(text: string, limit = OPTION_LABEL_LIMIT): string {
  const cleaned = text.replaceAll(/\s+/g, ' ').trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

/**
 * The rolling controls: one row per slot, cycling on the left and the full
 * list on the right.
 *
 * Both, not one or the other. Cycling is the right gesture for somebody with no
 * particular destination, and the list is the right one for somebody who came
 * here to put a specific hat on. Offering only the first makes the product a
 * slot machine; offering only the second makes idle exploration a chore.
 */
export function rollKeyboard(pack: TraitPack): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  pack.slots.forEach((slot, index) => {
    keyboard.text(label(slot.slot), slotAction(index));
    keyboard.text('☰', browseAction(index));
    keyboard.row();
  });

  keyboard.text('🎲 Reroll', REROLL).text('✓ Claim', CLAIM);

  return keyboard;
}

/**
 * One page of a slot's options.
 *
 * Every button carries a position on this page and nothing else. The slot and
 * the page it belongs to are held server-side, so there is no trait id here for
 * anybody to rewrite.
 */
export function browseKeyboard(view: BrowseView): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  view.options.forEach((option, position) => {
    // The held option is marked rather than removed, so the list always shows
    // where the member currently is.
    const text = option.selected ? `● ${label(option.trait.name)}` : label(option.trait.name);
    keyboard.text(text, optionAction(position));
    if ((position + 1) % OPTIONS_PER_ROW === 0) {
      keyboard.row();
    }
  });

  if (view.options.length % OPTIONS_PER_ROW !== 0) {
    keyboard.row();
  }

  if (view.pageCount > 1) {
    if (view.pageCount <= MAX_DIRECT_PAGES) {
      for (let page = 0; page < view.pageCount; page += 1) {
        const text = page === view.pageIndex ? `·${String(page + 1)}·` : String(page + 1);
        keyboard.text(text, browsePageAction(page));
      }
    } else {
      // Wrapping rather than clamping: a member on the last page reaching for
      // "next" should land on the first, not on a button that does nothing.
      const previous = (view.pageIndex - 1 + view.pageCount) % view.pageCount;
      const next = (view.pageIndex + 1) % view.pageCount;
      keyboard
        .text('‹', browsePageAction(previous))
        .text(
          `${String(view.pageIndex + 1)}/${String(view.pageCount)}`,
          browsePageAction(view.pageIndex),
        )
        .text('›', browsePageAction(next));
    }
    keyboard.row();
  }

  keyboard.text('← Back', CLOSE_BROWSE);

  return keyboard;
}

/**
 * Shown only after a member presses Claim. Confirming is irreversible, so the
 * destructive option is never one tap away from the rolling controls.
 */
export function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Yes, claim it permanently', CONFIRM_CLAIM)
    .row()
    .text('Go back', CANCEL_CLAIM);
}

/**
 * Offered beside "no wallet linked", so the reply names a next tap rather than
 * a second command to type.
 *
 * Telling somebody to send /wallet link is not a next action, it is homework.
 * The rest of this product answers a dead end with a button, and this reply
 * was the one place that did not.
 */
export function walletLinkKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('Link a wallet', WALLET_LINK);
}

/**
 * The questionnaire's buttons for whichever step is showing.
 *
 * Every option carries its position in the list this function was handed, so
 * there is no slot name or colour value in a payload for anybody to rewrite —
 * the same rule the browse keyboard follows, and it matters more here because
 * a forged slot would be an order against something the project never offered.
 */
export function commissionStepKeyboard(prompt: Prompt): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (prompt.step === 'slot' || prompt.step === 'colour') {
    const action = prompt.step === 'slot' ? commissionSlotAction : commissionColourAction;
    prompt.options.forEach((option, position) => {
      keyboard.text(label(option), action(position));
      if ((position + 1) % OPTIONS_PER_ROW === 0) {
        keyboard.row();
      }
    });
    if (prompt.options.length % OPTIONS_PER_ROW !== 0) {
      keyboard.row();
    }
  }

  if (prompt.step === 'confirm') {
    keyboard.text('Place the order', COMMISSION_ORDER).row();
  }

  // The slot is the one question with no skip: there is no commission without
  // one, and offering a button that can only be refused is a dead end.
  if (prompt.step !== 'slot' && prompt.step !== 'confirm') {
    keyboard.text('Skip', COMMISSION_SKIP).row();
  }

  keyboard.text('Cancel', COMMISSION_ABANDON);
  return keyboard;
}

/** Offered when a month is full, so "come back later" is a tap not a chore. */
export function waitlistKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('Tell me when slots open', COMMISSION_WAITLIST);
}

/**
 * What an operator can do to the commission in front of them.
 *
 * One tap each. Nothing here opens a text box, because an operator typing to a
 * member is the thing this whole design exists to prevent.
 */
export function queueKeyboard(status: CommissionStatus, hasMore: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (status === 'awaiting_payment') {
    // Manual confirmation, as the plan specifies at this stage. The operator
    // checks their wallet and taps; nothing here watches the chain.
    keyboard.text('Payment received', QUEUE_PAID).row();
  }
  if (status === 'awaiting_approval') {
    keyboard.text('Approve', QUEUE_APPROVE).text('Decline', QUEUE_DECLINE).row();
  }
  if (status === 'approved') {
    keyboard.text('Start drawing', QUEUE_PRODUCE).text('Decline', QUEUE_DECLINE).row();
  }
  if (status === 'in_production') {
    keyboard.text('Decline', QUEUE_DECLINE).row();
  }

  if (hasMore) {
    keyboard.text('Next', QUEUE_NEXT);
  }
  return keyboard;
}

/** The fixed decline reasons. The operator picks; they never write. */
export function declineReasonKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  DECLINE_REASONS.forEach((reason, position) => {
    keyboard.text(DECLINE_LABELS[reason], queueReasonAction(position)).row();
  });

  keyboard.text('← Back', QUEUE_BACK);
  return keyboard;
}
