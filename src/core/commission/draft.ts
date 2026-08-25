import { MAX_NOTE_LENGTH, MAX_TEXT_LENGTH, validateBrief } from './brief.js';
import type { BriefProblem, ValidBrief } from './brief.js';
import { COMMISSION_PALETTE, isPaletteColour } from './types.js';

/**
 * The commission questionnaire, as a step machine.
 *
 * A guided sequence rather than a blank box, and the reason is not politeness:
 * a vague brief is what creates conversation, and conversation between an
 * operator and a member is the thing this whole design exists to eliminate.
 * Every answer here is either a choice from a list or a hard-limited string.
 *
 * Pure. A draft in, an answer in, the next draft out — no database, no chat,
 * no side effects. That is what lets an interrupted questionnaire resume
 * exactly where it stopped: the draft *is* the position, so restoring it is
 * restoring the flow.
 */

export const DRAFT_STEPS = ['slot', 'colour', 'text', 'note', 'confirm'] as const;

export type DraftStep = (typeof DRAFT_STEPS)[number];

export interface CommissionDraft {
  readonly memberId: number;
  readonly projectId: number;
  readonly step: DraftStep;
  readonly slot: string | null;
  readonly colour: string | null;
  readonly textContent: string | null;
  readonly note: string | null;
  readonly referencePath: string | null;
}

export function startDraft(memberId: number, projectId: number): CommissionDraft {
  return {
    memberId,
    projectId,
    step: 'slot',
    slot: null,
    colour: null,
    textContent: null,
    note: null,
    referencePath: null,
  };
}

/**
 * What the member is being asked right now, and what would answer it.
 *
 * The front end renders this; it does not decide it. A Discord adapter asking
 * a different question in a different order would be a different product.
 */
export type Prompt =
  | { readonly step: 'slot'; readonly options: readonly string[] }
  | { readonly step: 'colour'; readonly options: readonly string[]; readonly skippable: true }
  | { readonly step: 'text'; readonly maxLength: number; readonly skippable: true }
  | { readonly step: 'note'; readonly maxLength: number; readonly skippable: true }
  | { readonly step: 'confirm'; readonly summary: DraftSummary };

export interface DraftSummary {
  readonly slot: string;
  readonly colour: string | null;
  readonly textContent: string | null;
  readonly note: string | null;
  readonly hasReference: boolean;
}

export function promptFor(draft: CommissionDraft, eligibleSlots: readonly string[]): Prompt {
  switch (draft.step) {
    case 'slot':
      return { step: 'slot', options: eligibleSlots };
    case 'colour':
      return { step: 'colour', options: COMMISSION_PALETTE, skippable: true };
    case 'text':
      return { step: 'text', maxLength: MAX_TEXT_LENGTH, skippable: true };
    case 'note':
      return { step: 'note', maxLength: MAX_NOTE_LENGTH, skippable: true };
    case 'confirm':
      return { step: 'confirm', summary: summarise(draft) };
  }
}

export function summarise(draft: CommissionDraft): DraftSummary {
  return {
    // Only reachable at confirm, by which point a slot has been chosen.
    slot: draft.slot ?? '',
    colour: draft.colour,
    textContent: draft.textContent,
    note: draft.note,
    hasReference: draft.referencePath !== null,
  };
}

/** The step after this one. Confirm is the end; it does not advance. */
function nextStep(step: DraftStep): DraftStep {
  const index = DRAFT_STEPS.indexOf(step);
  return DRAFT_STEPS[Math.min(index + 1, DRAFT_STEPS.length - 1)] ?? 'confirm';
}

export type AnswerResult =
  | { readonly ok: true; readonly draft: CommissionDraft }
  /** Names the field and the fix, and leaves the draft where it was. */
  | { readonly ok: false; readonly problem: BriefProblem };

/**
 * Applies an answer to the current step.
 *
 * Validated here rather than at submission, so a member is corrected at the
 * point of entry with the question still in front of them — not told at the
 * end that something they answered four steps ago was wrong.
 */
export function answer(
  draft: CommissionDraft,
  value: string,
  eligibleSlots: readonly string[],
): AnswerResult {
  switch (draft.step) {
    case 'slot': {
      if (!eligibleSlots.includes(value)) {
        return {
          ok: false,
          problem: {
            field: 'slot',
            message:
              eligibleSlots.length === 0
                ? 'This collection is not taking commissions for any slot right now.'
                : `Choose one of: ${eligibleSlots.join(', ')}.`,
          },
        };
      }
      return { ok: true, draft: { ...draft, slot: value, step: nextStep(draft.step) } };
    }

    case 'colour': {
      if (!isPaletteColour(value)) {
        return {
          ok: false,
          problem: {
            field: 'colour',
            message: 'Pick a colour from the list rather than describing one.',
          },
        };
      }
      return { ok: true, draft: { ...draft, colour: value, step: nextStep(draft.step) } };
    }

    case 'text':
    case 'note': {
      // Reuses the submission validator on a single field, so the rule a
      // member is corrected against here is the identical rule the finished
      // brief is checked against. Two copies would eventually disagree.
      const field = draft.step === 'text' ? 'textContent' : 'note';
      const checked = validateBrief(
        {
          slot: draft.slot ?? '',
          textContent: field === 'textContent' ? value : (draft.textContent ?? undefined),
          note: field === 'note' ? value : (draft.note ?? undefined),
          colour: draft.colour ?? undefined,
        },
        eligibleSlots,
      );

      if (!checked.ok) {
        const problem = checked.problems.find((entry) => entry.field === field);
        if (problem !== undefined) {
          return { ok: false, problem };
        }
      }

      const trimmed = value.trim();
      return {
        ok: true,
        draft: {
          ...draft,
          [field]: trimmed.length === 0 ? null : trimmed,
          step: nextStep(draft.step),
        },
      };
    }

    case 'confirm':
      // Nothing to answer. The caller places the order or starts over.
      return { ok: true, draft };
  }
}

/**
 * Skips an optional step.
 *
 * The slot is not skippable — there is no commission without one — and
 * refusing here rather than silently advancing means a front end that offered
 * the button by mistake gets a clear answer instead of a half-built order.
 */
export function skip(draft: CommissionDraft): AnswerResult {
  if (draft.step === 'slot') {
    return {
      ok: false,
      problem: { field: 'slot', message: 'Choose which slot you want customised.' },
    };
  }
  if (draft.step === 'confirm') {
    return { ok: true, draft };
  }
  return { ok: true, draft: { ...draft, step: nextStep(draft.step) } };
}

/** Attaches an optional reference image, whatever step they are on. */
export function attachReference(draft: CommissionDraft, path: string): CommissionDraft {
  return { ...draft, referencePath: path };
}

export type FinishResult =
  | { readonly ok: true; readonly brief: ValidBrief }
  | { readonly ok: false; readonly problems: readonly BriefProblem[] };

/**
 * Turns a completed draft into a brief, re-validating the whole thing.
 *
 * Re-checked even though every answer was checked on the way in: the eligible
 * slots can change while somebody is answering, and an order placed against a
 * slot the project has since withdrawn is an order nobody can produce.
 */
export function finish(draft: CommissionDraft, eligibleSlots: readonly string[]): FinishResult {
  const result = validateBrief(
    {
      slot: draft.slot ?? '',
      textContent: draft.textContent ?? undefined,
      colour: draft.colour ?? undefined,
      note: draft.note ?? undefined,
      referencePath: draft.referencePath ?? undefined,
    },
    eligibleSlots,
  );

  return result.ok ? { ok: true, brief: result.brief } : { ok: false, problems: result.problems };
}
