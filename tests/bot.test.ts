import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/bot/rate-limit.js';
import { createHarness, project } from './helpers/bot-harness.js';
import type { FakeDatabase } from './helpers/bot-harness.js';

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

const DB: FakeDatabase = {
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
};

describe('/start entry states', () => {
  it('serves the ready state for a live project', async () => {
    const harness = createHarness({ db: DB });
    await harness.send('/start test-live');

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toContain('Live Drop');
    expect(harness.sent[0]).toContain('open');
  });

  it('turns away a draft project', async () => {
    const harness = createHarness({ db: DB });
    await harness.send('/start test-draft');
    expect(harness.sent[0]).toContain('not open yet');
  });

  it('turns away a closed project', async () => {
    const harness = createHarness({ db: DB });
    await harness.send('/start test-closed');
    expect(harness.sent[0]).toContain('has closed');
  });

  it('holds a member back before the claim window opens', async () => {
    const harness = createHarness({ db: DB });
    await harness.send('/start test-early');
    expect(harness.sent[0]).toContain('opens at');
  });

  it('turns a member away after the claim window closes', async () => {
    const harness = createHarness({ db: DB });
    await harness.send('/start test-over');
    expect(harness.sent[0]).toContain('has closed');
  });

  it('shows an existing claim with its edition number', async () => {
    const harness = createHarness({ db: DB });
    await harness.send('/start test-held');
    expect(harness.sent[0]).toContain('#12');
  });

  it('gives one identical answer to a missing, unknown and malformed payload', async () => {
    const harness = createHarness({ db: DB });

    await harness.send('/start');
    await harness.send('/start no-such-project');
    await harness.send('/start BAD_SLUG!');
    await harness.send('/start ../../etc/passwd');

    // The bot must not become an oracle for probing which slugs exist.
    expect(new Set(harness.sent).size).toBe(1);
    expect(harness.sent[0]).toContain('does not lead to a collection I recognise');
  });

  it('never echoes the payload back, however it was crafted', async () => {
    const harness = createHarness({ db: DB });
    await harness.send('/start <script>alert(1)</script>');
    expect(harness.sent[0]).not.toContain('script');
  });

  it('does not leak whether a slug exists through reply timing of content', async () => {
    const harness = createHarness({ db: DB });
    await harness.send('/start test-live');
    await harness.send('/start test-liveX');

    expect(harness.sent[0]).not.toBe(harness.sent[1]);
    expect(harness.sent[1]).toContain('does not lead to');
  });
});

describe('rate limiting', () => {
  it('replies with a wait instead of dropping the update silently', async () => {
    const harness = createHarness({
      db: DB,
      rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }),
    });

    await harness.send('/start test-live');
    await harness.send('/start test-live');
    await harness.send('/start test-live');

    expect(harness.sent).toHaveLength(3);
    expect(harness.sent[2]).toContain('going a bit fast');
  });

  it('limits each member separately', async () => {
    const harness = createHarness({
      db: DB,
      rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    await harness.send('/start test-live', 111);
    await harness.send('/start test-live', 111);
    await harness.send('/start test-live', 222);

    expect(harness.sent[1]).toContain('going a bit fast');
    expect(harness.sent[2]).toContain('Live Drop');
  });
});

describe('session handling', () => {
  it('discards an abandoned roll when a member enters fresh', async () => {
    const harness = createHarness({ db: DB });

    await harness.sessions.set({
      memberId: 555,
      projectId: 1,
      traitIds: [9, 9, 9],
      messageId: 42,
    });
    await expect(harness.sessions.get(555, 1)).resolves.toBeDefined();

    await harness.send('/start test-live');

    await expect(harness.sessions.get(555, 1)).resolves.toBeUndefined();
  });

  it('leaves a session alone when entry is refused', async () => {
    const harness = createHarness({ db: DB });

    await harness.sessions.set({
      memberId: 555,
      projectId: 2,
      traitIds: [1, 2, 3],
      messageId: null,
    });

    await harness.send('/start test-draft');

    await expect(harness.sessions.get(555, 2)).resolves.toBeDefined();
  });
});
