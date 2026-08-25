import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createTraitFixtures, project } from './harness.js';
import type { FakeDatabase, TraitFixtures } from './harness.js';

/**
 * Public verification, and who may roll.
 *
 * Two properties carry these. /verify must never put a wallet address in a
 * group chat, and the eligibility gate must refuse anything it cannot
 * establish — including when Telegram itself will not answer.
 */

const GROUP = -1001234567890;
const MEMBER = 555;

let fixtures: TraitFixtures;

beforeAll(async () => {
  fixtures = await createTraitFixtures([
    { slot: 'background', layerOrder: 0, options: 2 },
    { slot: 'hat', layerOrder: 20, options: 2 },
  ]);
});

afterAll(async () => {
  await fixtures.cleanup();
});

function db(extra: Partial<FakeDatabase> = {}): FakeDatabase {
  return {
    projectsBySlug: new Map([['drop', project({ id: 1, name: 'Drop' })]]),
    claimsByProjectAndMember: new Map(),
    groupBinding: { groupId: String(GROUP), projectId: 1, name: 'Drop' },
    canvas: fixtures.canvas,
    traits: fixtures.traits,
    ...extra,
  };
}

/** A bot that can actually render, for the tests that reach the roll. */
function rollable(extra: Partial<FakeDatabase> = {}) {
  return createHarness({ db: db(extra), traitRoot: fixtures.root });
}

describe('/verify', () => {
  it('reports what a member holds', async () => {
    const h = createHarness({
      db: db({
        claimsByMember: new Map([
          [
            555,
            [
              { editionNumber: 7, tier: 'open', claimedAt: new Date('2026-08-01T00:00:00Z') },
              { editionNumber: 12, tier: 'legendary', claimedAt: new Date('2026-08-02T00:00:00Z') },
            ],
          ],
        ]),
      }),
    });

    await h.sendInGroup('/verify @tester', GROUP);

    const reply = h.sent.join('\n');
    expect(reply).toContain('@tester holds 2 pieces in Drop');
    expect(reply).toContain('#7');
    expect(reply).toContain('#12 (legendary)');
  });

  it('says plainly when somebody holds nothing', async () => {
    const h = createHarness({ db: db() });
    await h.sendInGroup('/verify @tester', GROUP);

    expect(h.sent.join('\n')).toContain('does not hold anything in Drop');
  });

  it('answers the same way for somebody who has never used the bot', async () => {
    const h = createHarness({ db: db() });
    await h.sendInGroup('/verify @astranger', GROUP);

    // Whether somebody has ever opened the bot is not a fact worth
    // broadcasting to a room, so the two answers are deliberately identical.
    expect(h.sent.join('\n')).toContain('does not hold anything in Drop');
  });

  it('never puts a wallet address in a group', async () => {
    const h = createHarness({
      db: db({
        wallets: new Map([
          [
            555,
            {
              walletAddress: 'So11111111111111111111111111111111111111112',
              walletLinkedAt: new Date(),
            },
          ],
        ]),
        claimsByMember: new Map([
          [555, [{ editionNumber: 3, tier: 'open', claimedAt: new Date('2026-08-01T00:00:00Z') }]],
        ]),
      }),
    });

    await h.sendInGroup('/verify @tester', GROUP);

    const reply = h.sent.join('\n');
    expect(reply).toContain('#3');
    // The lookup does not select the column, so there is nothing to print —
    // this asserts the outcome of that rather than trusting the formatter.
    expect(reply).not.toContain('So1111');
    expect(reply).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  });

  it('works with no channel configured, being nothing to do with gating', async () => {
    // The group binding is the announce channel; no gated-channel setup exists
    // and none is needed.
    const h = createHarness({ db: db() });
    await h.sendInGroup('/verify @tester', GROUP);

    expect(h.sent.join('\n')).toContain('Drop');
  });

  it('refuses to run outside a group', async () => {
    const h = createHarness({ db: db() });
    await h.send('/verify @tester', MEMBER);

    expect(h.sent.join('\n')).toContain('group chat');
  });

  it('says so when the group is not linked to a collection', async () => {
    const h = createHarness({ db: db({ groupBinding: undefined }) });
    await h.sendInGroup('/verify @tester', GROUP);

    expect(h.sent.join('\n')).toContain('not linked to a collection');
  });

  it('asks for a username when given none', async () => {
    const h = createHarness({ db: db() });
    await h.sendInGroup('/verify', GROUP);

    expect(h.sent.join('\n')).toContain('/verify @someone');
  });

  it('rate limits per group, not per person', async () => {
    const h = createHarness({ db: db() });

    // Ten different people in one room. Limiting by sender would let them take
    // turns; limiting by group is what actually bounds the work.
    for (let i = 0; i < 12; i += 1) {
      await h.sendInGroup('/verify @tester', GROUP, 600 + i);
    }

    expect(h.sent.some((text) => text.includes('asked a lot just now'))).toBe(true);
  });
});

describe('who may roll', () => {
  it('lets anybody in when the project gates on nothing', async () => {
    const h = rollable({ eligibilityRule: {} });
    await h.send('/start drop', MEMBER);

    // Reaches the roll rather than a refusal.
    expect(h.countOf('sendPhoto')).toBe(1);
  });

  it('refuses somebody outside the group, and says what to do', async () => {
    // getChatMember is never stubbed here, so the call fails — which is the
    // same shape as any check that cannot be completed.
    const h = rollable({ eligibilityRule: { kind: 'group-member', groupId: String(GROUP) } });
    await h.send('/start drop', MEMBER);

    // Refused, and never rolled.
    expect(h.countOf('sendPhoto')).toBe(0);
    const reply = h.sent.join('\n');
    // Names a next step rather than stopping at "no".
    expect(reply.length).toBeGreaterThan(20);
  });

  it('fails closed when the membership check cannot be completed', async () => {
    const h = rollable({ eligibilityRule: { kind: 'group-member', groupId: String(GROUP) } });
    await h.send('/start drop', MEMBER);

    // A gate that opened when getChatMember failed would open exactly when
    // something was wrong.
    expect(h.countOf('sendPhoto')).toBe(0);
  });

  it('fails closed on a rule it cannot read', async () => {
    const h = rollable({ eligibilityRule: { kind: 'group-tenure', groupId: String(GROUP) } });
    await h.send('/start drop', MEMBER);

    // A project that said something about entry and was misunderstood must not
    // quietly admit everybody.
    expect(h.countOf('sendPhoto')).toBe(0);
    expect(h.sent.join('\n')).toContain('could not check');
  });

  it('never mistakes an unreadable rule for an open one', async () => {
    const h = rollable({ eligibilityRule: { kind: 'nonsense' } });
    await h.send('/start drop', MEMBER);

    expect(h.countOf('sendPhoto')).toBe(0);
  });

  it('still shows an existing claim to somebody who has since left', async () => {
    // Checked after the already-claimed branch on purpose: what a member holds
    // is theirs permanently, whatever the project's entry rule now says.
    const h = rollable({
      eligibilityRule: { kind: 'group-member', groupId: String(GROUP) },
      claimsByProjectAndMember: new Map([['1:555', { editionNumber: 4 }]]),
    });
    await h.send('/start drop', MEMBER);

    expect(h.sent.join('\n')).toContain('#4');
    expect(h.sent.join('\n')).not.toContain('could not check');
  });
});
