import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { combinationHash } from '../../../src/core/render/hash.js';
import { createHarness, createTraitFixtures, project } from './harness.js';
import type { FakeDatabase, TraitFixtures } from './harness.js';

/**
 * Browsing, driven through real Telegram updates.
 *
 * The phase gate is a tap count and the absence of a spinner, and both are
 * properties of the whole round trip rather than of any one function — so they
 * are asserted here, against the handlers, with synthetic updates.
 */

let fixtures: TraitFixtures;
let DB: FakeDatabase;

const FIRST_MESSAGE = 1001;

beforeAll(async () => {
  fixtures = await createTraitFixtures([
    { slot: 'background', layerOrder: 0, options: 2 },
    // Forty options in one slot: the size the gate is written about.
    { slot: 'hat', layerOrder: 20, options: 40 },
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

/** Callback data on the most recent message that carried buttons. */
function lastButtons(h: ReturnType<typeof createHarness>): readonly string[] {
  for (let i = h.calls.length - 1; i >= 0; i -= 1) {
    const call = h.calls[i];
    if (call !== undefined && call.buttons.length > 0) {
      return call.buttons;
    }
  }
  return [];
}

describe('browsing a slot', () => {
  it('answers the callback query before doing any work, on every press', async () => {
    const h = harness();
    await h.send('/start drop');

    for (const press of ['b1', 'p2', 'o3', 'b1', 'q', 'r', 's1']) {
      const before = h.calls.length;
      await h.press(press, FIRST_MESSAGE);

      // The first thing that leaves the process for a button press is the
      // answer. Anything else first is a spinner on somebody's phone.
      expect(h.calls[before]?.method).toBe('answerCallbackQuery');
    }
  });

  it('offers a browse button for every slot alongside its cycle button', async () => {
    const h = harness();
    await h.send('/start drop');

    const buttons = lastButtons(h);
    expect(buttons).toContain('s0');
    expect(buttons).toContain('b0');
    expect(buttons).toContain('s1');
    expect(buttons).toContain('b1');
    expect(buttons).toContain('r');
    expect(buttons).toContain('c');
  });

  it('reaches any of forty options in four presses, and applies the one tapped', async () => {
    const h = harness();
    await h.send('/start drop');

    // Tap one: open the list.
    await h.press('b1', FIRST_MESSAGE);
    const listed = lastButtons(h);

    // A page row with every page on it, so the far end is one tap away.
    expect(listed).toContain('p0');
    expect(listed).toContain('p3');
    expect(listed).toContain('q');

    // Tap two: jump straight to the last page.
    await h.press('p3', FIRST_MESSAGE);
    const lastPage = lastButtons(h);
    expect(lastPage).toContain('o0');

    // Tap three: take the option there.
    const before = await h.sessions.get(555, 1);
    await h.press('o0', FIRST_MESSAGE);
    const after = await h.sessions.get(555, 1);

    // Three presses from the artwork to a specific far-end option, against a
    // gate of five. The hat moved and the background did not.
    expect(after?.traitIds[0]).toBe(before?.traitIds[0]);
    expect(after?.traitIds[1]).not.toBe(before?.traitIds[1]);

    // And the list closed, putting the rolling controls back.
    expect(lastButtons(h)).toContain('r');
    expect(after?.browse).toBeNull();
  });

  it('never puts a trait id in a button', async () => {
    const h = harness();
    await h.send('/start drop');
    await h.press('b1', FIRST_MESSAGE);
    await h.press('p2', FIRST_MESSAGE);

    // Every option button addresses a position on the page the server drew.
    // A payload carrying a trait id is a payload somebody can rewrite into
    // another trait id, and no button here has one to rewrite.
    for (const data of lastButtons(h)) {
      expect(data).toMatch(/^(o\d{1,2}|p\d{1,3}|q)$/);
    }
  });

  it('resolves a picked position against the page the server recorded', async () => {
    const h = harness();
    await h.send('/start drop');

    await h.press('b1', FIRST_MESSAGE);
    await h.press('p2', FIRST_MESSAGE);
    const onPageTwo = await h.sessions.get(555, 1);
    expect(onPageTwo?.browse).toEqual({ slotIndex: 1, pageIndex: 2 });

    await h.press('o1', FIRST_MESSAGE);
    const picked = (await h.sessions.get(555, 1))?.traitIds[1];

    // Page 2, position 1 of the hat slot. The pack has two backgrounds and
    // forty hats, ids 3..42, so this is the 26th hat.
    expect(picked).toBe(3 + 2 * 12 + 1);
  });

  it('ignores a position that is not on the open page', async () => {
    const h = harness();
    await h.send('/start drop');
    await h.press('b1', FIRST_MESSAGE);

    const before = await h.sessions.get(555, 1);
    // Twelve to a page, so position 40 is not on any page and cannot be.
    await h.press('o40', FIRST_MESSAGE);
    const after = await h.sessions.get(555, 1);

    // Nothing moved, and nothing was lost. An unusable button press must not
    // cost a member the combination they had built.
    expect(after?.traitIds).toEqual(before?.traitIds);
    expect(after?.browse).toEqual(before?.browse);
    expect(h.sent.some((text) => text.includes('expired'))).toBe(false);
  });

  it('goes back to the artwork with the controls restored', async () => {
    const h = harness();
    await h.send('/start drop');
    await h.press('b1', FIRST_MESSAGE);
    expect(lastButtons(h)).toContain('q');

    await h.press('q', FIRST_MESSAGE);

    const buttons = lastButtons(h);
    expect(buttons).toContain('r');
    expect(buttons).toContain('c');
    expect((await h.sessions.get(555, 1))?.browse).toBeNull();
  });
});

describe('landing on a combination somebody holds', () => {
  it('says it is taken, names slots to change, and never says who holds it', async () => {
    const h = harness();
    await h.send('/start drop');

    const session = await h.sessions.get(555, 1);
    const taken = combinationHash([...(session?.traitIds ?? [])]);

    // The same combination, now claimed by somebody else.
    const contested = harness({
      db: { ...DB, claimedHashes: new Map([[1, [taken]]]) },
    });
    await contested.send('/start drop');
    await contested.sessions.set({
      memberId: 555,
      projectId: 1,
      traitIds: session?.traitIds ?? [],
    });

    await contested.press('c', FIRST_MESSAGE);

    const reply = contested.sent.join('\n');
    expect(reply).toContain('already held');
    // Names a next tap rather than stopping at "taken".
    expect(reply).toMatch(/Changing the (background|hat)/);
    // Never the holder. Who owns a combination is not a member's business.
    expect(reply).not.toMatch(/tester|@|member|user \d/i);

    // And it refuses before the confirmation, not after it: the member is
    // never walked through "claim this permanently?" for something that
    // cannot be claimed.
    expect(contested.sent.some((text) => text.includes('Claim this one?'))).toBe(false);
  });

  it('marks the caption when the combination on screen is already gone', async () => {
    const h = harness();
    await h.send('/start drop');
    const session = await h.sessions.get(555, 1);
    const taken = combinationHash([...(session?.traitIds ?? [])]);

    const contested = harness({ db: { ...DB, claimedHashes: new Map([[1, [taken]]]) } });
    await contested.send('/start drop');
    await contested.sessions.set({
      memberId: 555,
      projectId: 1,
      traitIds: session?.traitIds ?? [],
    });

    // Closing a list re-presents, which is where the caption is refreshed.
    await contested.press('b1', FIRST_MESSAGE);
    await contested.press('q', FIRST_MESSAGE);

    expect(contested.sent.some((text) => text.includes('already holds this exact'))).toBe(true);
  });

  it('says the combination is free while it is', async () => {
    const h = harness();
    await h.send('/start drop');

    expect(h.sent.some((text) => text.includes('Still free'))).toBe(true);
  });
});
