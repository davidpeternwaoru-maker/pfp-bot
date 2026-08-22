import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../../src/core/rate-limit.js';
import { createHarness, createTraitFixtures, project } from './harness.js';
import type { FakeDatabase, TraitFixtures } from './harness.js';

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

let fixtures: TraitFixtures;
let DB: FakeDatabase;

beforeAll(async () => {
  fixtures = await createTraitFixtures([
    { slot: 'background', layerOrder: 0, options: 3 },
    { slot: 'body', layerOrder: 10, options: 3 },
  ]);

  DB = {
    projectsBySlug: new Map([
      ['test-live', project({ id: 1, name: 'Live Drop' })],
      ['test-draft', project({ id: 2, name: 'Draft Drop', status: 'draft' })],
      ['test-closed', project({ id: 3, name: 'Closed Drop', status: 'closed' })],
      ['test-early', project({ id: 4, name: 'Early Drop', claimOpensAt: FUTURE })],
      ['test-over', project({ id: 5, name: 'Over Drop', claimClosesAt: PAST })],
      ['test-held', project({ id: 6, name: 'Held Drop' })],
    ]),
    // Member id equals the Telegram user id in the harness, so user 555 holds
    // edition #12 in project 6.
    claimsByProjectAndMember: new Map([['6:555', { editionNumber: 12 }]]),
    canvas: fixtures.canvas,
    traits: fixtures.traits,
  };
});

afterAll(async () => {
  await fixtures.cleanup();
});

function harness(overrides: Partial<Parameters<typeof createHarness>[0]> = {}) {
  return createHarness({ db: DB, traitRoot: fixtures.root, ...overrides });
}

describe('/start entry states', () => {
  it('rolls immediately for a live project rather than replying with text', async () => {
    const h = harness();
    await h.send('/start test-live');

    expect(h.countOf('sendPhoto')).toBe(1);
    expect(h.sent[0]).toContain('background:');
    expect(h.sent[0]).toContain('body:');
  });

  it('turns away a draft project', async () => {
    const h = harness();
    await h.send('/start test-draft');
    expect(h.sent[0]).toContain('not open yet');
    expect(h.countOf('sendPhoto')).toBe(0);
  });

  it('turns away a closed project', async () => {
    const h = harness();
    await h.send('/start test-closed');
    expect(h.sent[0]).toContain('has closed');
  });

  it('holds a member back before the claim window opens', async () => {
    const h = harness();
    await h.send('/start test-early');
    expect(h.sent[0]).toContain('opens at');
  });

  it('turns a member away after the claim window closes', async () => {
    const h = harness();
    await h.send('/start test-over');
    expect(h.sent[0]).toContain('has closed');
  });

  it('shows an existing claim with its edition number', async () => {
    const h = harness();
    await h.send('/start test-held');
    expect(h.sent[0]).toContain('#12');
    expect(h.countOf('sendPhoto')).toBe(0);
  });

  it('gives one identical answer to a missing, unknown and malformed payload', async () => {
    const h = harness();

    await h.send('/start');
    await h.send('/start no-such-project');
    await h.send('/start BAD_SLUG!');
    await h.send('/start ../../etc/passwd');

    // The bot must not become an oracle for probing which slugs exist.
    expect(new Set(h.sent).size).toBe(1);
    expect(h.sent[0]).toContain('does not lead to a collection I recognise');
  });

  it('never echoes the payload back, however it was crafted', async () => {
    const h = harness();
    await h.send('/start <script>alert(1)</script>');
    expect(h.sent[0]).not.toContain('script');
  });
});

describe('rate limiting', () => {
  it('replies with a wait instead of dropping the update silently', async () => {
    const h = harness({ rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) });

    await h.send('/start test-live');
    await h.send('/start test-live');
    await h.send('/start test-live');

    expect(h.sent[2]).toContain('going a bit fast');
  });

  it('limits each member separately', async () => {
    const h = harness({ rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) });

    await h.send('/start test-live', 111);
    await h.send('/start test-live', 111);
    await h.send('/start test-live', 222);

    expect(h.sent[1]).toContain('going a bit fast');
    expect(h.countOf('sendPhoto')).toBe(2);
  });

  it('answers a throttled button press so the client stops spinning', async () => {
    const h = harness({ rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) });

    await h.send('/start test-live');
    await h.press('r', 1001);

    expect(h.countOf('answerCallbackQuery')).toBe(1);
    expect(h.sent.at(-1)).toContain('going a bit fast');
  });
});

describe('session handling', () => {
  it('records the rolled combination and the message being edited', async () => {
    const h = harness();
    await h.send('/start test-live');

    const session = await h.sessions.get(555, 1);
    expect(session?.traitIds).toHaveLength(2);
    // Where it is displayed is the adapter's business, not the session's.
    await expect(h.bindings.messageFor(555, 1)).resolves.toBe(1001);
  });

  it('discards an abandoned roll when a member enters fresh', async () => {
    const h = harness();

    await h.sessions.set({ memberId: 555, projectId: 1, traitIds: [9, 9] });
    await h.send('/start test-live');

    const session = await h.sessions.get(555, 1);
    expect(session?.traitIds).not.toEqual([9, 9]);
    await expect(h.bindings.messageFor(555, 1)).resolves.toBe(1001);
  });

  it('leaves a session alone when entry is refused', async () => {
    const h = harness();

    await h.sessions.set({ memberId: 555, projectId: 2, traitIds: [1, 2] });
    await h.send('/start test-draft');

    await expect(h.sessions.get(555, 2)).resolves.toBeDefined();
  });
});
