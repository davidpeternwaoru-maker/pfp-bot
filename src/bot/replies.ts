import type { EntryOutcome } from './entry.js';
import type { TraitRecord } from '../render/types.js';

/**
 * Every reply is plain text and no handler ever sets parse_mode. A project
 * name is admin-supplied and could contain markdown; without a parse mode it
 * is displayed literally and can neither break formatting nor inject entities.
 */

export const GENERIC_ERROR =
  'Something went wrong on our side. Nothing was lost — please try again in a moment.';

export function rateLimitReply(retryAfterSeconds: number): string {
  return `You're going a bit fast. Try again in ${String(retryAfterSeconds)}s.`;
}

function formatMoment(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function entryReply(outcome: EntryOutcome): string {
  switch (outcome.kind) {
    case 'unknown-project':
      // Deliberately identical for a missing, malformed, and unmatched payload:
      // the reply must not become an oracle for probing which slugs exist.
      return 'That link does not lead to a collection I recognise. Ask the community for a current one.';

    case 'not-open':
      return outcome.status === 'draft'
        ? `${outcome.projectName} is not open yet. Check back when the community announces it.`
        : `${outcome.projectName} has closed. No further claims are possible.`;

    case 'not-yet-open':
      return `${outcome.projectName} opens at ${formatMoment(outcome.opensAt)}. Come back then.`;

    case 'window-closed':
      return `${outcome.projectName} has closed. No further claims are possible.`;

    case 'already-claimed':
      return `You already hold edition #${String(outcome.editionNumber)} in ${outcome.projectName}. One per member — that one is yours permanently.`;

    case 'ready':
      // Unused in practice: a ready member is sent a rolled image instead of
      // text. Kept so the union stays exhaustive if that ever changes.
      return `${outcome.projectName} is open. Rolling now…`;
  }
}

export const ROLL_EXHAUSTED =
  'Every combination in this collection has been claimed. Nothing is left to roll.';

export const ROLL_UNDETERMINED =
  'The pool is very nearly claimed out and I could not find a free combination just now. Try once more.';

export const ROLL_STALE = 'This roll has expired. Open the link again to start a new one.';

export const ROLL_SLOT_STUCK = 'No other option fits there with what you are holding.';

export const CLAIM_NOT_ENABLED =
  'Claiming is not switched on yet. Your roll is safe — reroll away.';

export const ROLL_RENDER_FAILED =
  'That combination would not render. Nothing is lost — try rerolling.';

/** Caption under the rolled image: what the member is currently holding. */
export function rollCaption(traits: readonly TraitRecord[]): string {
  const lines = traits.map((trait) => `${trait.slot}: ${trait.name}`);
  return [...lines, '', 'Reroll, adjust a slot, or claim it.'].join('\n');
}
