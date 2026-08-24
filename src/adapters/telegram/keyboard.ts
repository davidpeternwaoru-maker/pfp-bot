import type { BrowseView, TraitPack } from '../../core/ports.js';
import { InlineKeyboard } from 'grammy';
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
