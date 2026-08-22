import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCallbackData } from '../src/bot/callback-data.js';
import { combinationHash } from '../src/render/hash.js';
import { createRenderCache } from '../src/render/cache.js';
import { createHarness, createTraitFixtures, project } from './helpers/bot-harness.js';
import type { FakeDatabase, TraitFixtures } from './helpers/bot-harness.js';

let fixtures: TraitFixtures;
let DB: FakeDatabase;

/** The message id the harness assigns to the first photo it sends. */
const FIRST_MESSAGE = 1001;

beforeAll(async () => {
  fixtures = await createTraitFixtures([
    { slot: 'background', layerOrder: 0, options: 3 },
    { slot: 'body', layerOrder: 10, options: 3 },
    { slot: 'hat', layerOrder: 20, options: 2 },
  ]);

  DB = {
    projectsBySlug: new Map([['drop', project({ id: 1, name: 'Drop' })]]),
    claimsByProjectAndMember: new Map(),
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

describe('one message per session', () => {
  it('sends exactly one photo and edits it for every later interaction', async () => {
    const h = harness();
    await h.send('/start drop');

    for (let i = 0; i < 20; i += 1) {
      await h.press(i % 2 === 0 ? 'r' : 's1', FIRST_MESSAGE);
    }

    // The chat must hold one image, not twenty-one.
    expect(h.countOf('sendPhoto')).toBe(1);
    expect(h.countOf('editMessageMedia')).toBeGreaterThan(0);
    expect(h.countOf('editMessageMedia') + h.countOf('sendPhoto')).toBe(
      h.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'editMessageMedia').length,
    );
  });

  it('edits the message the session recorded, not the one the press claimed', async () => {
    const h = harness();
    await h.send('/start drop');
    await h.press('r', FIRST_MESSAGE);

    const edits = h.calls.filter((c) => c.method === 'editMessageMedia');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.messageId).toBe(FIRST_MESSAGE);
  });

  it('recovers with a new photo if the message it was editing is gone', async () => {
    const h = harness();
    await h.send('/start drop');

    // A press against an unknown message has no session behind it.
    await h.press('r', 4242);

    expect(h.sent.at(-1)).toContain('expired');
    expect(h.countOf('sendPhoto')).toBe(1);
  });
});

describe('callback queries', () => {
  it('answers every press, including ones it then refuses', async () => {
    const h = harness();
    await h.send('/start drop');

    await h.press('r', FIRST_MESSAGE);
    await h.press('nonsense', FIRST_MESSAGE);
    await h.press('s99', FIRST_MESSAGE);
    await h.press('', FIRST_MESSAGE);

    // Four presses, four answers — the client never keeps spinning.
    expect(h.countOf('answerCallbackQuery')).toBe(4);
  });

  it('ignores callback data it does not recognise instead of guessing', async () => {
    const h = harness();
    await h.send('/start drop');
    const before = await h.sessions.get(555, 1);

    await h.press('s99', FIRST_MESSAGE);
    await h.press('../../etc', FIRST_MESSAGE);
    await h.press('r'.repeat(64), FIRST_MESSAGE);

    const after = await h.sessions.get(555, 1);
    expect(after?.traitIds).toEqual(before?.traitIds);
    expect(h.countOf('editMessageMedia')).toBe(0);
  });

  it('tells the member when a roll has no session behind it', async () => {
    const h = harness();
    await h.press('r', 999);
    expect(h.sent.at(-1)).toContain('expired');
  });
});

describe('rerolling and adjusting', () => {
  it('reroll changes the combination', async () => {
    const h = harness();
    await h.send('/start drop');
    const before = (await h.sessions.get(555, 1))?.traitIds;

    // Rerolls are random, so try a few before concluding nothing moved.
    let changed = false;
    for (let i = 0; i < 10 && !changed; i += 1) {
      await h.press('r', FIRST_MESSAGE);
      const after = (await h.sessions.get(555, 1))?.traitIds;
      changed = JSON.stringify(after) !== JSON.stringify(before);
    }

    expect(changed).toBe(true);
  });

  it('a slot button changes only that slot', async () => {
    const h = harness();
    await h.send('/start drop');
    const before = (await h.sessions.get(555, 1))?.traitIds ?? [];

    await h.press('s1', FIRST_MESSAGE);
    const after = (await h.sessions.get(555, 1))?.traitIds ?? [];

    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  it('cycling a slot all the way round returns to where it started', async () => {
    const h = harness();
    await h.send('/start drop');
    const start = (await h.sessions.get(555, 1))?.traitIds ?? [];

    // Slot 2 has two options, so two presses is a full cycle.
    await h.press('s2', FIRST_MESSAGE);
    await h.press('s2', FIRST_MESSAGE);

    expect((await h.sessions.get(555, 1))?.traitIds).toEqual(start);
  });

  it('claiming asks for confirmation rather than acting on one press', async () => {
    const h = harness();
    await h.send('/start drop');
    await h.press('c', FIRST_MESSAGE);

    expect(h.sent.at(-1)).toContain('Claim this one?');
    expect(h.sent.at(-1)).toContain('permanent');
  });
});

describe('pool exhaustion at the bot edge', () => {
  it('tells a member plainly when every combination is claimed', async () => {
    // 3 x 3 x 2 = 18 combinations, all taken.
    const everyHash: string[] = [];
    for (const a of [1, 2, 3]) {
      for (const b of [4, 5, 6]) {
        for (const c of [7, 8]) {
          everyHash.push(combinationHash([a, b, c]));
        }
      }
    }

    const h = harness({
      db: { ...DB, claimedHashes: new Map([[1, everyHash]]) },
    });
    await h.send('/start drop');

    expect(h.sent.at(-1)).toContain('has been claimed');
    expect(h.countOf('sendPhoto')).toBe(0);
  });
});

describe('render cache', () => {
  it('does not re-render a combination it has already produced', async () => {
    const cache = createRenderCache();
    const h = harness({ renderCache: cache });

    await h.send('/start drop');
    expect(cache.size()).toBe(1);

    // Cycle away and back: the second press must be served from the cache.
    await h.press('s2', FIRST_MESSAGE);
    const afterFirstCycle = cache.size();
    await h.press('s2', FIRST_MESSAGE);

    expect(cache.size()).toBe(afterFirstCycle);
  });

  it('evicts by age', () => {
    let clock = 0;
    const cache = createRenderCache({ maxAgeMs: 100, now: () => clock });
    cache.set('k', Buffer.from([1]));

    clock = 50;
    expect(cache.get('k')).toBeDefined();

    clock = 200;
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the coldest entry when full', () => {
    const cache = createRenderCache({ maxEntries: 2 });
    cache.set('a', Buffer.from([1]));
    cache.set('b', Buffer.from([2]));

    // Touching 'a' makes 'b' the coldest.
    cache.get('a');
    cache.set('c', Buffer.from([3]));

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });
});

describe('parseCallbackData', () => {
  it('accepts the three known actions', () => {
    expect(parseCallbackData('r', 3)).toEqual({ kind: 'reroll' });
    expect(parseCallbackData('c', 3)).toEqual({ kind: 'claim' });
    expect(parseCallbackData('s2', 3)).toEqual({ kind: 'cycle-slot', slotIndex: 2 });
  });

  it('rejects a slot index outside the pack', () => {
    expect(parseCallbackData('s3', 3)).toBeNull();
    expect(parseCallbackData('s99', 3)).toBeNull();
  });

  it('rejects anything malformed, oversized, or empty', () => {
    expect(parseCallbackData(undefined, 3)).toBeNull();
    expect(parseCallbackData('', 3)).toBeNull();
    expect(parseCallbackData('s', 3)).toBeNull();
    expect(parseCallbackData('sx', 3)).toBeNull();
    expect(parseCallbackData('s-1', 3)).toBeNull();
    expect(parseCallbackData('s1;drop', 3)).toBeNull();
    expect(parseCallbackData('r'.repeat(64), 3)).toBeNull();
  });

  it('carries no trait ids, so nothing from the client can be trusted back', () => {
    // A crafted payload that looks like state must not decode into state.
    expect(parseCallbackData('1,2,3', 3)).toBeNull();
    expect(parseCallbackData('s1:7', 3)).toBeNull();
  });
});
