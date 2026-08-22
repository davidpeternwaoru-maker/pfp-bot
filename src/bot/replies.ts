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

export const ROLL_RENDER_FAILED =
  'That combination would not render. Nothing is lost — try rerolling.';

/** Caption under the rolled image: what the member is currently holding. */
export function rollCaption(traits: readonly TraitRecord[]): string {
  const lines = traits.map((trait) => `${trait.slot}: ${trait.name}`);
  return [...lines, '', 'Reroll, adjust a slot, or claim it.'].join('\n');
}

/** Shown before a claim is committed. It must not undersell permanence. */
export function claimConfirmPrompt(traits: readonly TraitRecord[]): string {
  return [
    'Claim this one?',
    '',
    ...traits.map((trait) => `${trait.slot}: ${trait.name}`),
    '',
    'This is permanent. The combination is locked to you and nobody else in this',
    'collection can ever hold it. You get one claim per collection, so this will',
    'be your only one here — you cannot swap it later.',
  ].join('\n');
}

export function claimedReply(
  projectName: string,
  editionNumber: number,
  traits: readonly TraitRecord[],
): string {
  return [
    `Edition #${String(editionNumber)} of ${projectName} is yours.`,
    '',
    ...traits.map((trait) => `${trait.slot}: ${trait.name}`),
    '',
    'Locked to you permanently. Use /mine to get the full-resolution file.',
  ].join('\n');
}

export const CLAIM_RACE_LOST =
  'Sorry — somebody claimed that exact combination a moment before you. Nothing is lost. Here is a fresh one that is still free.';

export const CLAIM_COMBINATION_INVALID =
  'That combination is no longer available to claim. Here is a fresh one.';

export const CLAIM_CANCELLED = 'Not claimed. Keep rolling.';

export const CLAIM_NONE_YET =
  'You have not claimed in this collection yet. Open the link again to roll one.';

export const CLAIM_NEEDS_PROJECT =
  'Tell me which collection: send /mine followed by its link name, or open the collection link again.';

export function existingClaimReply(
  projectName: string,
  editionNumber: number,
  claimedAt: Date,
): string {
  return [
    `You hold edition #${String(editionNumber)} of ${projectName}.`,
    `Claimed ${claimedAt.toISOString().slice(0, 10)}.`,
    '',
    'Full-resolution file attached.',
  ].join('\n');
}

/**
 * Posted to the community group. Deliberately does not name the claimant:
 * claiming is not consent to be announced publicly, and the edition number is
 * what the group actually cares about.
 */
export function announcementText(
  projectName: string,
  editionNumber: number,
  traits: readonly TraitRecord[],
): string {
  return [
    `Edition #${String(editionNumber)} of ${projectName} has been claimed.`,
    traits.map((trait) => trait.name).join(' · '),
  ].join('\n');
}
