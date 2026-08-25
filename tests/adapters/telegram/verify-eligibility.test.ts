import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createTraitFixtures, project } from './harness.js';
import type { FakeDatabase, TraitFixtures } from './harness.js';

/**
 * Public verification, and who may roll.
 *
 * Two properties carry this file. A wallet address must never reach a group
 * chat — checked by asserting no reply ever contains one, since the lookup
 * does not select the column at all. And a gate that cannot be checked must
 * refuse, because a gate that opened on error would open exactly when
 * something was wrong.
 */

const GROUP = -1001234567890;
const MEMBER = 555;
const HOLDER = 777;

/** A wallet that must never appear in any reply this file produces. */
const WALLET = '52zYzWq1P6ZKNQvGeaLBTt8xN1cFxYVnQxxHMSPnWSkd';

/**
 * A real pack, because the tests that let somebody through go on to roll.
 * A fixture with no traits fails inside the renderer, which reads in a test
 * exactly like an eligibility bug and is not one.
 */
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

function db(overrides: Partial<FakeDatabase> = {}): FakeDatabase {
  return {
    projectsBySlug: new Map([['drop', project({ id: 1, name: 'Drop' })]]),
    claimsByProjectAndMember: new Map(),
    groupBinding: { groupId: String(GROUP), projectId: 1, name: 'Drop' },
    wallets: new Map([[HOLDER, { walletAddress: WALLET, walletLinkedAt: new Date() }]]),
    canvas: fixtures.canvas,
    traits: fixtures.traits,
    ...overrides,
  };
}

function harness(overrides: Partial<Parameters<typeof createHarness>[0]> = {}) {
  return createHarness({ db: db(), traitRoot: fixtures.root, ...overrides });
}

describe('/verify', () => {
  it('reports what a member holds, to the whole group', async () => {
    const h = harness({
      db: db({
        claimsByMember: new Map([
          [
            HOLDER,
            [
              { editionNumber: 7, tier: 'open', claimedAt: new Date('2026-08-01T00:00:00Z') },
              { editionNumber: 12, tier: 'legendary', claimedAt: new Date('2026-08-05T00:00:00Z') },
            ],
          ],
        ]),
      }),
    });

    await h.sendInGroup('/verify @holder', GROUP);

    const reply = h.sent.join('\n');
    expect(reply).toContain('@holder holds 2 pieces in Drop');
    expect(reply).toContain('#7');
    expect(reply).toContain('#12 (legendary)');
  });

  it('never puts a wallet address in a group chat', async () => {
    const h = harness({
      db: db({
        claimsByMember: new Map([
          [HOLDER, [{ editionNumber: 1, tier: 'open', claimedAt: new Date() }]],
        ]),
      }),
    });

    await h.sendInGroup('/verify @holder', GROUP);

    // The lookup does not select the column, so there is nothing to leak by
    // formatting carelessly. Asserted anyway, because this is the one thing
    // a public command must never do.
    const reply = h.sent.join('\n');
    expect(reply).not.toContain(WALLET);
    expect(reply).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  });

  it('says plainly when somebody holds nothing', async () => {
    const h = harness();
    await h.sendInGroup('/verify @holder', GROUP);

    expect(h.sent.join('\n')).toContain('does not hold anything in Drop');
  });

  it('answers the same way for somebody who has never used the bot', async () => {
    const h = harness();
    await h.sendInGroup('/verify @astranger', GROUP);

    // Whether somebody has ever opened the bot is not a fact to broadcast to
    // a room, so an unknown handle and a known one holding nothing look alike.
    expect(h.sent.join('\n')).toContain('does not hold anything in Drop');
    expect(h.sent.join('\n')).not.toMatch(/never|unknown|not found/i);
  });

  it('works with no channel configured, because it is not channel gating', async () => {
    // The binding is the announce group and nothing else. No gated channel,
    // no invite links, no membership check — verification stands alone.
    const h = harness();
    await h.sendInGroup('/verify @holder', GROUP);

    expect(h.sent.join('\n')).toContain('Drop');
  });

  it('refuses outside a group, where there is no collection to answer about', async () => {
    const h = harness();
    await h.send('/verify @holder', MEMBER);

    expect(h.sent.join('\n')).toContain('group chat');
  });

  it('says so when the group is not linked to a collection', async () => {
    const h = harness({ db: db({ groupBinding: undefined }) });
    await h.sendInGroup('/verify @holder', GROUP);

    expect(h.sent.join('\n')).toContain('not linked to a collection');
  });

  it('asks for a username when none is given', async () => {
    const h = harness();
    await h.sendInGroup('/verify', GROUP);

    expect(h.sent.join('\n')).toContain('followed by a username');
  });

  it('rate limits per group rather than per person', async () => {
    const h = harness();

    // Ten different people in one room. Limiting by sender would let them
    // take turns hammering it; limiting by group is what bounds the work.
    for (let i = 0; i < 12; i += 1) {
      await h.sendInGroup('/verify @holder', GROUP, 600 + i);
    }

    expect(h.sent.some((text) => text.includes('asked a lot just now'))).toBe(true);
  });

  it("does not let one group exhaust another group's allowance", async () => {
    const h = harness({
      db: db({ groupBinding: { groupId: String(GROUP), projectId: 1, name: 'Drop' } }),
    });

    for (let i = 0; i < 12; i += 1) {
      await h.sendInGroup('/verify @holder', GROUP, MEMBER);
    }
    const before = h.sent.length;

    // A different room, which has asked for nothing.
    await h.sendInGroup('/verify @holder', -100999, MEMBER);

    const latest = h.sent.slice(before).join('\n');
    expect(latest).not.toContain('asked a lot just now');
  });
});

describe('who may roll', () => {
  it('lets anybody through when the project gates on nothing', async () => {
    const h = harness({ db: db({ eligibilityRule: {} }) });
    await h.send('/start drop', MEMBER);

    // The ordinary case, and it must not have cost a membership check.
    expect(h.countOf('sendPhoto')).toBe(1);
  });

  it('turns somebody away who is not in the group, and says what to do', async () => {
    const h = harness({
      db: db({ eligibilityRule: { kind: 'group-member', groupId: String(GROUP) } }),
      chatMemberStatus: 'left',
    });

    await h.send('/start drop', MEMBER);

    const reply = h.sent.join('\n');
    expect(reply).toContain('community group');
    // Never a bare rejection: it names the next step and reassures.
    expect(reply).toContain('Join the group');
    expect(reply).toContain('Nothing is lost');
    expect(h.countOf('sendPhoto')).toBe(0);
  });

  it('lets a member of the group through', async () => {
    const h = harness({
      db: db({ eligibilityRule: { kind: 'group-member', groupId: String(GROUP) } }),
      chatMemberStatus: 'member',
    });

    await h.send('/start drop', MEMBER);
    expect(h.countOf('sendPhoto')).toBe(1);
  });

  it('refuses when the check itself failed, and says so distinctly', async () => {
    const h = harness({
      db: db({ eligibilityRule: { kind: 'group-member', groupId: String(GROUP) } }),
      chatMemberStatus: 'error',
    });

    await h.send('/start drop', MEMBER);

    const reply = h.sent.join('\n');
    // Not "you are not in the group" — that would send somebody off to join
    // one they may already be in.
    expect(reply).toContain('could not check');
    expect(reply).toContain('not yours');
    expect(h.countOf('sendPhoto')).toBe(0);
  });

  it('refuses an unreadable rule rather than treating it as open', async () => {
    const h = harness({
      db: db({ eligibilityRule: { kind: 'group-tenure', groupId: String(GROUP) } }),
      chatMemberStatus: 'member',
    });

    await h.send('/start drop', MEMBER);

    // A project that said something about entry and was misunderstood must not
    // quietly admit everybody.
    expect(h.sent.join('\n')).toContain('could not check');
    expect(h.countOf('sendPhoto')).toBe(0);
  });

  it('turns away somebody who has not been in the group long enough', async () => {
    const h = harness({
      db: db({
        eligibilityRule: { kind: 'group-tenure', groupId: String(GROUP), minimumDays: 30 },
      }),
      chatMemberStatus: 'member',
    });

    await h.send('/start drop', MEMBER);

    const reply = h.sent.join('\n');
    expect(reply).toContain('at least 30 days');
    // A date to come back on, rather than a wall.
    expect(reply).toMatch(/You can roll from \d{4}-\d{2}-\d{2}/);
    expect(h.countOf('sendPhoto')).toBe(0);
  });

  it('still shows an existing claim to somebody who has since left the group', async () => {
    const h = harness({
      db: db({
        eligibilityRule: { kind: 'group-member', groupId: String(GROUP) },
        claimsByProjectAndMember: new Map([['1:555', { editionNumber: 4 }]]),
      }),
      chatMemberStatus: 'left',
    });

    await h.send('/start drop', MEMBER);

    // Eligibility gates rolling, not looking. Somebody who already holds one
    // must always be able to see it.
    const reply = h.sent.join('\n');
    expect(reply).toContain('#4');
    expect(reply).not.toContain('Join the group');
  });
});
