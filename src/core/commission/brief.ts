import { isPaletteColour } from './types.js';
import type { CommissionColour } from './types.js';

/**
 * Validating a commission brief.
 *
 * Every field is either chosen from a list or hard length-limited, and the
 * limits are enforced here rather than trusted from whatever collected them.
 * A brief arrives from a chat client: the text is attacker-controlled, and it
 * will later be read by a human and typeset into artwork somebody pays for.
 *
 * Rejections name the field and the fix, because a member correcting an entry
 * needs to know which entry and what is wrong with it. "Invalid brief" is a
 * dead end; "the text is 34 characters, the limit is 24" is a next action.
 *
 * Pure. No database, no filesystem, no rendering.
 */

/**
 * Short enough to sit legibly on artwork at profile-picture size. This is the
 * real constraint — a longer string is not a preference to be talked round,
 * it physically will not read once the image is 128 pixels wide.
 */
export const MAX_TEXT_LENGTH = 24;

/** Room for one genuine instruction, not a specification to negotiate over. */
export const MAX_NOTE_LENGTH = 280;

/**
 * Printable characters only, and no line breaks.
 *
 * Excludes control characters, zero-width joiners and bidirectional overrides
 * — all of which render as nothing, or as something other than what they are,
 * in a queue an operator is approving at a glance. A brief that looks
 * different to the approver than to the illustrator is the one thing an
 * approval gate cannot tolerate.
 */
const ALLOWED_TEXT = /^[\p{L}\p{N}\p{P}\p{Zs}]+$/u;

/** Deliberately narrower than the note: this one may end up in the artwork. */
const ALLOWED_DISPLAY_TEXT = /^[A-Za-z0-9 '&.,!?_-]+$/;

export interface BriefInput {
  readonly slot: string;
  readonly textContent?: string | undefined;
  readonly colour?: string | undefined;
  readonly note?: string | undefined;
  readonly referencePath?: string | undefined;
}

export interface ValidBrief {
  readonly slot: string;
  readonly textContent: string | null;
  readonly colour: CommissionColour | null;
  readonly note: string | null;
  readonly referencePath: string | null;
}

export interface BriefProblem {
  /** Which answer to go back to. */
  readonly field: 'slot' | 'textContent' | 'colour' | 'note';
  /** Says what is wrong and what would fix it. Shown to the member as-is. */
  readonly message: string;
}

export type BriefResult =
  | { readonly ok: true; readonly brief: ValidBrief }
  | { readonly ok: false; readonly problems: readonly BriefProblem[] };

/**
 * Checks a whole brief and reports every problem at once.
 *
 * All of them, not the first: a member fixing one field, resubmitting, and
 * being told about the next is the drip-feed that makes forms hateful.
 */
export function validateBrief(input: BriefInput, eligibleSlots: readonly string[]): BriefResult {
  const problems: BriefProblem[] = [];

  if (!eligibleSlots.includes(input.slot)) {
    problems.push({
      field: 'slot',
      message:
        eligibleSlots.length === 0
          ? 'This collection is not taking commissions for any slot right now.'
          : `Choose one of: ${eligibleSlots.join(', ')}.`,
    });
  }

  const text = normalise(input.textContent);
  if (text !== null) {
    if (text.length > MAX_TEXT_LENGTH) {
      problems.push({
        field: 'textContent',
        message: `That is ${String(text.length)} characters. The limit is ${String(MAX_TEXT_LENGTH)}, because longer will not read at profile-picture size.`,
      });
    } else if (!ALLOWED_DISPLAY_TEXT.test(text)) {
      problems.push({
        field: 'textContent',
        message: 'Use letters, numbers and basic punctuation only — no emoji or symbols.',
      });
    }
  }

  const colour = normalise(input.colour);
  if (colour !== null && !isPaletteColour(colour)) {
    problems.push({
      field: 'colour',
      message: 'Pick a colour from the list rather than describing one.',
    });
  }

  const note = normalise(input.note);
  if (note !== null) {
    if (note.length > MAX_NOTE_LENGTH) {
      problems.push({
        field: 'note',
        message: `That note is ${String(note.length)} characters. The limit is ${String(MAX_NOTE_LENGTH)} — say the one thing that matters most.`,
      });
    } else if (!ALLOWED_TEXT.test(note)) {
      problems.push({
        field: 'note',
        message: 'Use plain text only — no line breaks or unusual characters.',
      });
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    brief: {
      slot: input.slot,
      textContent: text,
      colour: colour === null ? null : (colour as CommissionColour),
      note,
      referencePath: normalise(input.referencePath),
    },
  };
}

/**
 * Trims, and treats blank as absent.
 *
 * A field somebody left empty and a field somebody filled with spaces mean the
 * same thing, and storing the second as a value would put whitespace in front
 * of an illustrator as though it were an instruction.
 */
function normalise(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
