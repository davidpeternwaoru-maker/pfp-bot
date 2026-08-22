import { InlineKeyboard } from 'grammy';
import { CLAIM, REROLL, slotAction } from './callback-data.js';
import type { TraitPack } from '../render/types.js';

/** Beyond this, button labels start truncating on a narrow phone. */
const SLOT_BUTTONS_PER_ROW = 3;

/** Slot names come from an admin import, so they are trimmed before display. */
function slotLabel(slot: string): string {
  const cleaned = slot.replaceAll(/\s+/g, ' ').trim();
  return cleaned.length > 16 ? `${cleaned.slice(0, 15)}…` : cleaned;
}

export function rollKeyboard(pack: TraitPack): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  pack.slots.forEach((slot, index) => {
    keyboard.text(slotLabel(slot.slot), slotAction(index));
    const isRowEnd = (index + 1) % SLOT_BUTTONS_PER_ROW === 0;
    if (isRowEnd && index < pack.slots.length - 1) {
      keyboard.row();
    }
  });

  keyboard.row();
  keyboard.text('🎲 Reroll', REROLL).text('✓ Claim', CLAIM);

  return keyboard;
}
