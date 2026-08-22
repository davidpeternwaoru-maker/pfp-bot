import type { EntryOutcome } from './entry.js';

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
      return `${outcome.projectName} is open and you have not claimed yet. Rolling is not wired up until the next phase.`;
  }
}
