import type {
  BrowseView,
  CollisionAdvice,
  EntryOutcome,
  TraitRecord,
  TraitTier,
} from '../../core/ports.js';

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

/**
 * Caption under the rolled image: what the member is currently holding, and
 * whether it is still theirs to take.
 *
 * The availability line is advisory and reads that way. "Still free" rather
 * than "reserved" is the honest wording — nothing is held back until the claim
 * itself, and a member told it was reserved who then lost a race would have
 * been lied to by this caption.
 */
export function rollCaption(traits: readonly TraitRecord[], available = true): string {
  const lines = traits.map((trait) => `${trait.slot}: ${trait.name}`);
  return [
    ...lines,
    '',
    available
      ? '✓ Still free — yours to claim.'
      : '✕ Somebody already holds this exact combination.',
    '',
    available ? 'Reroll, adjust a slot, or claim it.' : 'Change a slot to find a free one.',
  ].join('\n');
}

/** Caption over a slot's option list: where they are, and what is not shown. */
export function browseCaption(view: BrowseView): string {
  const lines = [
    view.pageCount > 1
      ? `${view.slotName} — ${String(view.total)} options, page ${String(view.pageIndex + 1)} of ${String(view.pageCount)}`
      : `${view.slotName} — ${String(view.total)} options`,
  ];

  if (view.hiddenByExclusion > 0) {
    // Never silently: a member who counted the options in the artwork and sees
    // fewer here is owed the reason, and the reason names the fix.
    lines.push(
      '',
      view.hiddenByExclusion === 1
        ? '1 option is hidden because it clashes with another slot. Change that slot to reach it.'
        : `${String(view.hiddenByExclusion)} options are hidden because they clash with another slot. Change that slot to reach them.`,
    );
  }

  lines.push('', 'Pick one, or go back.');
  return lines.join('\n');
}

/**
 * What a member is told when they have assembled something already held.
 *
 * Once browsing exists this stops being a race somebody lost and becomes a
 * place they deliberately walked to, so it is written to land as scarcity
 * rather than as a fault. It never says who holds it: that is not a member's
 * business, and naming them invites exactly the pressure this product should
 * never create.
 */
export function collisionReply(advice: CollisionAdvice): string {
  if (advice.stuck) {
    return [
      'That exact combination is already held.',
      '',
      'Everything one step away from it is taken too, so this corner of the collection is claimed out. Reroll for somewhere with more room.',
    ].join('\n');
  }

  const slots = advice.freeingSlots;
  const named =
    slots.length === 1
      ? `the ${slots[0] ?? ''}`
      : `the ${slots.slice(0, -1).join(', the ')} or the ${slots[slots.length - 1] ?? ''}`;

  return [
    'That exact combination is already held — somebody got there first, and it is theirs permanently.',
    '',
    `Changing ${named} would land on one nobody has yet.`,
  ].join('\n');
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
  tier: TraitTier = 'open',
): string {
  const badge = tier === 'open' ? '' : ` (${tier})`;
  return [
    `You hold edition #${String(editionNumber)} of ${projectName}${badge}.`,
    `Claimed ${claimedAt.toISOString().slice(0, 10)}.`,
    '',
    'Full-resolution file attached.',
  ].join('\n');
}

/**
 * Posted to the community group.
 *
 * The handle is safe to interpolate: normaliseUsername has already restricted
 * it to [A-Za-z0-9_]{1,32}, and nothing in this file sets a parse mode, so it
 * renders literally rather than as markup. A member with no username is still
 * announced, just without one.
 */
export function announcementText(
  projectName: string,
  editionNumber: number,
  traits: readonly TraitRecord[],
  claimantUsername: string | null,
): string {
  const who = claimantUsername === null ? 'A member' : `@${claimantUsername}`;
  return [
    `${who} just claimed edition #${String(editionNumber)} of ${projectName}.`,
    traits.map((trait) => trait.name).join(' · '),
  ].join('\n');
}

/**
 * Wallet copy.
 *
 * Every line here is written on the assumption that a member reading it may
 * later be shown a convincing fake of it. So it states, more than once and in
 * the plainest words available, that nothing in this product ever asks for a
 * seed phrase — because the most valuable thing this bot can teach somebody is
 * what a scam looks like when it arrives.
 */

export const WALLET_DISABLED =
  'Wallet linking is not switched on for this bot. Nothing here needs one — claiming works without a wallet.';

export const WALLET_NEVER_ASKS =
  'We will never ask for your seed phrase or private key. Not here, not on the page, not ever. Anyone who does is stealing from you.';

export function walletLinkPrompt(url: string, minutes: number): string {
  return [
    'Open this to link your wallet:',
    url,
    '',
    `The link works once and lasts ${String(minutes)} minutes.`,
    '',
    'You will be asked to sign a message. It is not a transaction: it moves no',
    'funds, approves no spending, and gives no access to your wallet.',
    '',
    WALLET_NEVER_ASKS,
  ].join('\n');
}

export function walletLinked(address: string, linkedAt: Date): string {
  return [
    'Wallet linked.',
    `${address}`,
    `Verified ${formatMoment(linkedAt)}.`,
    '',
    'Send /wallet unlink to remove it. Linking again needs a fresh signature.',
  ].join('\n');
}

export const WALLET_NONE_LINKED =
  'No wallet linked. Send /wallet link to connect one. It is optional — claiming works without it.';

export const WALLET_UNLINKED =
  'Wallet unlinked. It is no longer connected to your account, and linking again will need a fresh signature.';

export const WALLET_NOTHING_TO_UNLINK =
  'You do not have a wallet linked, so there is nothing to remove.';

export function walletRateLimited(retryAfterSeconds: number): string {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `That is a lot of link attempts. Try again in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`;
}
