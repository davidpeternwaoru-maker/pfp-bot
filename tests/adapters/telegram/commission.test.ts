import { describe, expect, it } from 'vitest';
import { createHarness, project } from './harness.js';
import type { FakeCommissionTerms, FakeDatabase } from './harness.js';

/**
 * Commissioning, driven through real Telegram updates.
 *
 * The governing rule of this phase is that the operator never writes a message
 * to a member. So the tests worth having are the ones that would catch a text
 * box creeping in: a decline is a tap that produces fixed wording, and every
 * refusal a member sees is generated rather than composed.
 */

const MEMBER = 555;
const OPERATOR = 999;
const FIRST_MESSAGE = 1001;

const TERMS: FakeCommissionTerms = {
  enabled: true,
  priceUsdcCents: 5_000,
  treasuryShareBps: 1_250,
  monthlyCapacity: 5,
  eligibleSlots: ['hat', 'eyes'],
  tokenMint: null,
  tokenMinimum: null,
};

function db(overrides: Partial<FakeCommissionTerms> = {}, extra: Partial<FakeDatabase> = {}) {
  return {
    projectsBySlug: new Map([['drop', project({ id: 1, name: 'Drop' })]]),
    claimsByProjectAndMember: new Map(),
    commissionTerms: new Map([[1, { ...TERMS, ...overrides }]]),
    ...extra,
  } satisfies FakeDatabase;
}

function harness(overrides: Partial<Parameters<typeof createHarness>[0]> = {}) {
  return createHarness({ db: db(), adminIds: [String(OPERATOR)], ...overrides });
}

function buttons(h: ReturnType<typeof createHarness>): readonly string[] {
  for (let i = h.calls.length - 1; i >= 0; i -= 1) {
    const call = h.calls[i];
    if (call !== undefined && call.buttons.length > 0) {
      return call.buttons;
    }
  }
  return [];
}

/** Answers the whole questionnaire and places the order. */
async function orderCommission(h: ReturnType<typeof createHarness>): Promise<void> {
  await h.send('/commission drop', MEMBER);
  await h.press('ms0', FIRST_MESSAGE, MEMBER); // hat
  await h.press('mc0', FIRST_MESSAGE, MEMBER); // first colour
  await h.press('mk', FIRST_MESSAGE, MEMBER); // skip text
  await h.press('mk', FIRST_MESSAGE, MEMBER); // skip note
  await h.press('mo', FIRST_MESSAGE, MEMBER); // place the order
}

describe('the questionnaire', () => {
  it('says what it costs before asking anything', async () => {
    const h = harness();
    await h.send('/commission drop', MEMBER);

    const reply = h.sent.join('\n');
    expect(reply).toContain('50.00 USDC');
    // Nobody should start answering without knowing what it is.
    expect(reply).toContain('never transferable');
    expect(reply).toContain('rarity statistics');
  });

  it('offers the project’s own eligible slots, not a fixed list', async () => {
    const h = harness();
    await h.send('/commission drop', MEMBER);

    expect(h.sent.join('\n')).toContain('Which part');
    // Two eligible slots, so two option buttons plus cancel.
    expect(buttons(h)).toContain('ms0');
    expect(buttons(h)).toContain('ms1');
    expect(buttons(h)).not.toContain('ms2');
  });

  it('never puts a slot name or colour value in a button', async () => {
    const h = harness();
    await h.send('/commission drop', MEMBER);

    // A forged slot would be an order against something the project never
    // offered, so positions travel and values stay server-side.
    for (const data of buttons(h)) {
      expect(data).toMatch(/^(ms\d{1,2}|mx)$/);
    }
  });

  it('does not offer a skip on the one question that has no default', async () => {
    const h = harness();
    await h.send('/commission drop', MEMBER);

    // There is no commission without a slot, and a button that can only be
    // refused is a dead end wearing a button.
    expect(buttons(h)).not.toContain('mk');
  });

  it('walks to a summary the member sees before anything is ordered', async () => {
    const h = harness();
    await h.send('/commission drop', MEMBER);
    await h.press('ms0', FIRST_MESSAGE, MEMBER);
    await h.press('mc0', FIRST_MESSAGE, MEMBER);
    await h.press('mk', FIRST_MESSAGE, MEMBER);
    await h.press('mk', FIRST_MESSAGE, MEMBER);

    const reply = h.sent.join('\n');
    expect(reply).toContain('Here is your brief');
    expect(reply).toContain('Part: hat');
    expect(buttons(h)).toContain('mo');
  });

  it('corrects a typed answer at the point of entry', async () => {
    const h = harness();
    await h.send('/commission drop', MEMBER);
    await h.press('ms0', FIRST_MESSAGE, MEMBER);
    await h.press('mc0', FIRST_MESSAGE, MEMBER);

    await h.send('x'.repeat(40), MEMBER);

    // Told which answer and why, with the question still in front of them —
    // not told at the end that something four steps back was wrong.
    const reply = h.sent.join('\n');
    expect(reply).toContain('40 characters');
    expect(reply).toContain('Any text on it?');
  });

  it('resumes exactly where it stopped', async () => {
    const h = harness();
    await h.send('/commission drop', MEMBER);
    await h.press('ms0', FIRST_MESSAGE, MEMBER);

    // They wander off, then come back with the same command.
    await h.send('/commission drop', MEMBER);

    // Back on the colour question, with the slot already answered.
    expect(h.sent[h.sent.length - 1]).toContain('colour');

    // And asked once, not twice. Making somebody re-answer a question they
    // already answered is the thing "resumes where it stopped" rules out.
    const askedForSlot = h.sent.filter((text) => text.includes('Which part')).length;
    expect(askedForSlot).toBe(1);

    // The introduction is not repeated either — they have already read it.
    expect(h.sent.filter((text) => text.includes('A commission is artwork'))).toHaveLength(1);
  });

  it('places an order and says what happens next', async () => {
    const h = harness();
    await orderCommission(h);

    const reply = h.sent.join('\n');
    expect(reply).toContain('Order received');
    expect(reply).toContain('50.00 USDC');
    // An order must never go silent, so the reply says who acts next.
    expect(reply).toContain('approval');
  });

  it('shows the status of an order already in flight', async () => {
    const h = harness();
    await orderCommission(h);
    await h.send('/commission drop', MEMBER);

    expect(h.sent[h.sent.length - 1]).toContain('waiting for your payment');
  });

  it('clears the answers when a member cancels', async () => {
    const h = harness();
    await h.send('/commission drop', MEMBER);
    await h.press('ms0', FIRST_MESSAGE, MEMBER);
    await h.press('mx', FIRST_MESSAGE, MEMBER);

    expect(h.sent.join('\n')).toContain('Nothing ordered');
  });
});

describe('refusals', () => {
  it('says so plainly when a project sells no commissions', async () => {
    const h = createHarness({
      db: {
        projectsBySlug: new Map([['drop', project({ id: 1, name: 'Drop' })]]),
        claimsByProjectAndMember: new Map(),
      },
    });
    await h.send('/commission drop', MEMBER);

    expect(h.sent.join('\n')).toContain('not taking commissions');
  });

  it('names the threshold rather than leaving a member to guess', async () => {
    const h = harness({
      db: db({ tokenMint: 'MintAddress1111', tokenMinimum: '1000' }),
    });
    await h.send('/commission drop', MEMBER);

    const reply = h.sent.join('\n');
    expect(reply).toContain('1000 tokens');
    // And names the next action rather than stopping at "not eligible".
    expect(reply).toContain('/wallet');
  });

  it('offers a waitlist button when the month is full', async () => {
    const h = harness({
      db: db({}, { commissionsThisMonth: new Map([[1, 5]]) }),
    });
    await h.send('/commission drop', MEMBER);

    const reply = h.sent.join('\n');
    expect(reply).toContain('this month is full');
    // "Come back later" is a tap, not a chore.
    expect(buttons(h)).toContain('mw');

    await h.press('mw', FIRST_MESSAGE, MEMBER);
    expect(h.sent.join('\n')).toContain('on the list');
  });
});

describe('the operator queue', () => {
  it('refuses anybody who is not an operator, and says nothing about the queue', async () => {
    const h = harness();
    await h.send('/queue', MEMBER);

    const reply = h.sent.join('\n');
    expect(reply).toContain('for operators');
    // The refusal must not become a way to learn what is waiting.
    expect(reply).not.toContain('Ordered');
    expect(reply).not.toContain('Drop');
  });

  it('refuses a forged queue button from a non-operator', async () => {
    const h = harness();
    // Authorisation comes from the sender, never from the payload.
    await h.press('na', FIRST_MESSAGE, MEMBER);

    expect(h.sent.join('\n')).toContain('for operators');
  });

  it('says the queue is clear rather than showing nothing', async () => {
    const h = harness();
    await h.send('/queue', OPERATOR);

    expect(h.sent.join('\n')).toContain('queue is clear');
  });

  it('shows a waiting order with its brief and a payment button', async () => {
    const h = harness();
    await orderCommission(h);
    await h.send('/queue', OPERATOR);

    const reply = h.sent.join('\n');
    // Everything needed to judge it in one glance.
    expect(reply).toContain('Part: hat');
    expect(reply).toContain('50.00 USDC');
    expect(reply).toContain('Paid: no');
    // Manual confirmation, as the plan specifies at this stage.
    expect(buttons(h)).toContain('np');
  });

  it('walks payment, approval and production, each in one tap', async () => {
    const h = harness();
    await orderCommission(h);
    await h.send('/queue', OPERATOR);

    await h.press('np', FIRST_MESSAGE, OPERATOR);
    expect(h.sent.join('\n')).toContain('Payment recorded');
    expect(buttons(h)).toContain('na');

    await h.press('na', FIRST_MESSAGE, OPERATOR);
    expect(h.sent.join('\n')).toContain('Approved');

    await h.press('ns', FIRST_MESSAGE, OPERATOR);
    expect(h.sent.join('\n')).toContain('Marked as being drawn');

    // The member was told at every step without the operator writing a word.
    const member = h.sent.join('\n');
    expect(member).toContain('has been approved');
    expect(member).toContain('being drawn now');
  });

  it('declines with a fixed reason and never a typed one', async () => {
    const h = harness();
    await orderCommission(h);
    await h.send('/queue', OPERATOR);
    await h.press('np', FIRST_MESSAGE, OPERATOR);

    await h.press('nd', FIRST_MESSAGE, OPERATOR);

    // Every reason is a button. Nothing here opens a text box, because an
    // operator composing a decline is an operator negotiating.
    expect(h.sent.join('\n')).toContain('Why is it declined?');
    expect(h.sent.join('\n')).toContain('You do not write anything');
    for (const data of buttons(h)) {
      expect(data).toMatch(/^(nr\d{1,2}|nb)$/);
    }

    await h.press('nr0', FIRST_MESSAGE, OPERATOR);

    const reply = h.sent.join('\n');
    expect(reply).toContain('Declined');
    // The member gets the fixed wording, which names what would be accepted
    // instead — a decline is a next order, not a door closing.
    expect(reply).toContain('somebody else owns');
    expect(reply).toContain('welcome to order again');
    // And is told about the refund without having to chase it.
    expect(reply).toContain('refunded in full');
  });

  it('tells the second operator somebody got there first', async () => {
    const h = harness({ adminIds: [String(OPERATOR), '888'] });
    await orderCommission(h);

    await h.send('/queue', OPERATOR);
    await h.send('/queue', 888);

    await h.press('np', FIRST_MESSAGE, OPERATOR);
    await h.press('np', FIRST_MESSAGE, 888);

    // Not a silent overwrite of a decision already taken and notified.
    expect(h.sent.join('\n')).toContain('got there first');
  });
});
