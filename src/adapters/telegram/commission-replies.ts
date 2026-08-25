import type {
  CommissionStatus,
  CommissionView,
  DeclineReason,
  DraftSummary,
  EligibilityRefusal,
  Prompt,
} from '../../core/ports.js';
import { formatUsdc } from '../../core/ports.js';

/**
 * What a member and an operator read about a commission.
 *
 * Two rules run through all of it. Every refusal names what would fix it or
 * when to come back, because "not eligible" is a dead end and this product
 * does not ship those. And the operator never writes any of it — a decline is
 * a tap, and the words a member receives come from here, fixed in advance and
 * reviewed once rather than composed under pressure.
 */

function moment(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function day(when: Date): string {
  return when.toISOString().slice(0, 10);
}

export const COMMISSION_NEEDS_PROJECT =
  'Tell me which collection: send /commission followed by its link name.';

/** Says what it is and what it costs before anybody starts answering. */
export function commissionIntro(projectName: string, priceUsdcCents: number): string {
  return [
    `A commission is artwork drawn for you alone in ${projectName}.`,
    '',
    `Price: ${formatUsdc(priceUsdcCents)}.`,
    'It is yours permanently, it is never transferable, and it never appears in',
    'the collection’s rarity statistics — so ordering one takes nothing away',
    'from anybody who already holds a piece.',
    '',
    'A few short questions follow. Nothing is charged until you confirm.',
  ].join('\n');
}

/** Why a member cannot order, and what to do about it. */
export function eligibilityReply(refusal: EligibilityRefusal, projectName: string): string {
  switch (refusal.kind) {
    case 'disabled':
      return `${projectName} is not taking commissions at the moment.`;

    case 'no-eligible-slots':
      return `${projectName} has not opened any slot for commissions yet.`;

    case 'at-capacity':
      return [
        `${projectName} takes ${String(refusal.capacity)} commissions a month, and this month is full.`,
        '',
        `The next slots open on ${day(refusal.reopensAt)}.`,
        'I can tell you the moment they do.',
      ].join('\n');

    case 'already-ordered':
      return [
        'You already have a commission in progress here.',
        '',
        'Send /commission again with the collection name to see how it is going.',
      ].join('\n');

    case 'wallet-required':
      // Names the threshold rather than leaving them to guess at a number the
      // project has already published.
      return [
        `Commissions in this collection are for holders of ${String(refusal.minimum)} tokens or more.`,
        '',
        'Link a wallet with /wallet so I can check your holding. Linking proves',
        'ownership by signature only — it moves nothing and approves nothing.',
      ].join('\n');

    case 'below-threshold':
      // How far short, not merely that they are short.
      return [
        `Commissions here need ${String(refusal.minimum)} tokens. Your linked wallet holds ${String(refusal.held)}.`,
        '',
        'The check runs again whenever you order, so come back once that changes.',
      ].join('\n');

    case 'holding-unverifiable':
      // Deliberately not "you do not hold enough": that would send somebody
      // buying tokens they may already have.
      return [
        'I could not check your token balance just now, so I cannot open a',
        'commission yet. This is a problem on our side, not yours.',
        '',
        'Try again in a few minutes.',
      ].join('\n');
  }
}

const STEP_TITLES: Readonly<Record<Prompt['step'], string>> = {
  slot: 'Which part would you like drawn for you?',
  colour: 'A colour to work around?',
  text: 'Any text on it?',
  note: 'Anything else the artist should know?',
  confirm: 'Here is your brief.',
};

export function stepPrompt(prompt: Prompt): string {
  switch (prompt.step) {
    case 'slot':
      return [STEP_TITLES.slot, '', 'This is the one part that is yours alone.'].join('\n');

    case 'colour':
      return [STEP_TITLES.colour, '', 'Pick one, or skip and leave it to the artist.'].join('\n');

    case 'text':
      return [
        STEP_TITLES.text,
        '',
        `Type it, or skip. Up to ${String(prompt.maxLength)} characters — longer will not read`,
        'at profile-picture size.',
      ].join('\n');

    case 'note':
      return [
        STEP_TITLES.note,
        '',
        `Type one thing, or skip. Up to ${String(prompt.maxLength)} characters.`,
        'You can also send a reference image at any point.',
      ].join('\n');

    case 'confirm':
      return briefSummary(prompt.summary);
  }
}

export function briefSummary(summary: DraftSummary): string {
  const lines = [STEP_TITLES.confirm, '', `Part: ${summary.slot}`];

  lines.push(`Colour: ${summary.colour ?? 'artist’s choice'}`);
  lines.push(`Text: ${summary.textContent ?? 'none'}`);
  lines.push(`Note: ${summary.note ?? 'none'}`);
  if (summary.hasReference) {
    lines.push('Reference image: attached');
  }

  lines.push(
    '',
    'Ordering places it in the queue. Nothing is charged automatically — you',
    'will be told what to pay and where, and the artwork only starts after',
    'the order has been approved.',
  );
  return lines.join('\n');
}

/** Shown the moment an order exists, so nobody is left wondering. */
export function orderPlaced(priceUsdcCents: number): string {
  return [
    'Order received.',
    '',
    `Next: pay ${formatUsdc(priceUsdcCents)} in USDC. You will be sent the payment details.`,
    '',
    'Once payment is confirmed the order goes to the artist for approval. I will',
    'tell you at every step — you never have to ask.',
  ].join('\n');
}

export const ORDER_ABANDONED =
  'Nothing ordered, and your answers are cleared. Send /commission with the collection name to start again.';

export function waitlistJoined(reopensAt: Date): string {
  return `You are on the list. I will message you when slots open on ${day(reopensAt)}.`;
}

/** Plain words for a status, for a member who asked where theirs is. */
const STATUS_WORDS: Readonly<Record<CommissionStatus, string>> = {
  awaiting_payment: 'waiting for your payment',
  awaiting_approval: 'paid, and waiting to be approved',
  approved: 'approved, and queued to be drawn',
  in_production: 'being drawn now',
  delivered: 'delivered',
  declined: 'declined',
  cancelled: 'cancelled',
};

export function commissionStatusReply(view: CommissionView): string {
  const lines = [
    `Your commission in ${view.projectName} is ${STATUS_WORDS[view.status]}.`,
    '',
    `Ordered ${day(view.createdAt)}.`,
  ];

  const brief = view.briefs[0];
  if (brief !== undefined) {
    lines.push(
      '',
      `Part: ${brief.slot}`,
      `Colour: ${brief.colour ?? 'artist’s choice'}`,
      `Text: ${brief.textContent ?? 'none'}`,
    );
  }

  if (view.status === 'awaiting_payment') {
    lines.push('', `Still to pay: ${formatUsdc(view.priceUsdcCents)}.`);
  }
  if (view.status === 'declined' && view.declineReason !== null) {
    lines.push('', declineExplanation(view.declineReason, view.paidAt !== null));
  }
  if (view.status === 'delivered' && view.deliveredAt !== null) {
    lines.push('', `Delivered ${day(view.deliveredAt)}. Use /collection to see it.`);
  }

  return lines.join('\n');
}

/**
 * The canned decline wording.
 *
 * Fixed text rather than anything the operator types, and that is the point of
 * the whole approval gate: an operator composing a decline is an operator
 * negotiating, and negotiation is what this design exists to remove. Each one
 * says what cannot be produced and what would be accepted instead, so a
 * decline is a next order rather than a door closing.
 */
export function declineExplanation(reason: DeclineReason, refundOwed: boolean): string {
  const body = ((): string => {
    switch (reason) {
      case 'copyrighted_material':
        return 'It asked for a character, logo or design somebody else owns, and we cannot draw those. An original idea in the same spirit is fine.';
      case 'real_person':
        return 'It asked for a real person’s face. We only draw invented characters.';
      case 'prohibited_content':
        return 'The brief asked for something we will not draw.';
      case 'rival_branding':
        return 'It asked for another project’s branding, which this collection cannot carry.';
      case 'not_producible':
        return 'It cannot be drawn as described at this size. Something simpler would work.';
      case 'brief_unclear':
        return 'The brief was not clear enough to draw from with confidence.';
    }
  })();

  const lines = ['Your commission was not approved.', '', body];

  if (refundOwed) {
    // Said plainly and without being asked. Somebody who paid and was refused
    // should never have to chase the money.
    lines.push('', 'You will be refunded in full. No action is needed from you.');
  }
  lines.push('', 'You are welcome to order again with a different brief.');

  return lines.join('\n');
}

/** Sent unprompted on every transition, so an order never goes silent. */
export function statusNotification(view: CommissionView): string {
  switch (view.status) {
    case 'awaiting_approval':
      return `Payment received for your commission in ${view.projectName}. It is now with the artist for approval.`;
    case 'approved':
      return `Your commission in ${view.projectName} has been approved. It is queued to be drawn.`;
    case 'in_production':
      return `Your commission in ${view.projectName} is being drawn now.`;
    case 'delivered':
      return `Your commission in ${view.projectName} is finished and is now in your collection. Use /mine to get the full-resolution file.`;
    case 'declined':
      return declineExplanation(view.declineReason ?? 'brief_unclear', view.paidAt !== null);
    case 'cancelled':
      return `Your commission in ${view.projectName} has been cancelled. Nothing was charged.`;
    case 'awaiting_payment':
      return `Your commission in ${view.projectName} is waiting for payment.`;
  }
}

// ---------------------------------------------------------------------------
// The operator side
// ---------------------------------------------------------------------------

export const QUEUE_EMPTY = 'Nothing waiting. The queue is clear.';

export const QUEUE_NOT_ADMIN = 'That command is for operators.';

/** One commission, as the operator needs to judge it in a single glance. */
export function queueEntry(view: CommissionView, position: number, total: number): string {
  const brief = view.briefs[0];
  const lines = [
    `${String(position + 1)} of ${String(total)} — ${view.projectName}`,
    `Ordered ${moment(view.createdAt)}`,
    `Status: ${STATUS_WORDS[view.status]}`,
    '',
  ];

  if (brief !== undefined) {
    if (brief.revision > 0) {
      // Flagged, because approving the original when a revision exists is the
      // easiest possible mistake to make from a glance.
      lines.push(`REVISED BRIEF (revision ${String(brief.revision)})`);
    }
    lines.push(
      `Part: ${brief.slot}`,
      `Colour: ${brief.colour ?? 'artist’s choice'}`,
      `Text: ${brief.textContent ?? 'none'}`,
      `Note: ${brief.note ?? 'none'}`,
    );
    if (brief.referencePath !== null) {
      lines.push('Reference image: attached');
    }
  }

  lines.push(
    '',
    `Paid: ${view.paidAt === null ? 'no' : moment(view.paidAt)}`,
    `Price: ${formatUsdc(view.priceUsdcCents)}`,
  );

  return lines.join('\n');
}

export const QUEUE_PICK_REASON = [
  'Why is it declined?',
  '',
  'The member is told automatically, in fixed wording. You do not write anything.',
].join('\n');

/** Short labels for the decline buttons. */
export const DECLINE_LABELS: Readonly<Record<DeclineReason, string>> = {
  copyrighted_material: 'Somebody else’s IP',
  real_person: 'A real person',
  prohibited_content: 'Content we refuse',
  rival_branding: 'Rival branding',
  not_producible: 'Cannot be drawn',
  brief_unclear: 'Brief unclear',
};

export function queueActionTaken(view: CommissionView): string {
  switch (view.status) {
    case 'awaiting_approval':
      return 'Payment recorded. It is now waiting for your approval.';
    case 'approved':
      return 'Approved. The member has been told.';
    case 'in_production':
      return 'Marked as being drawn. The member has been told.';
    case 'declined':
      return view.paidAt === null
        ? 'Declined. The member has been told.'
        : 'Declined. The member has been told, and a refund is now on the payables report.';
    default:
      return 'Done.';
  }
}

/** Somebody else got there first. */
export function queueMovedOn(actual: CommissionStatus | null): string {
  return actual === null
    ? 'That commission is no longer there.'
    : `Somebody got there first — it is already ${STATUS_WORDS[actual]}.`;
}
