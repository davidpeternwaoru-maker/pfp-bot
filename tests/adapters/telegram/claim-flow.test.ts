import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createTraitFixtures, project } from './harness.js';
import { makeTempRoot } from '../../helpers/fixtures.js';
import type { FakeDatabase, TraitFixtures } from './harness.js';

/**
 * The claim flow as a member experiences it. The database is faked here — the
 * constraints themselves are proved against real PostgreSQL in
 * claim.concurrency.test.ts, which is where that belongs.
 */

let fixtures: TraitFixtures;
let claimRoot: string;
let DB: FakeDatabase;

const FIRST_MESSAGE = 1001;

beforeAll(async () => {
  fixtures = await createTraitFixtures([
    { slot: 'background', layerOrder: 0, options: 3 },
    { slot: 'body', layerOrder: 10, options: 3 },
  ]);
  claimRoot = await makeTempRoot();

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
  return createHarness({ db: DB, traitRoot: fixtures.root, claimRoot, ...overrides });
}

describe('claim confirmation', () => {
  it('never claims on a single press', async () => {
    const h = harness();
    await h.send('/start drop');
    await h.press('c', FIRST_MESSAGE);

    // The first press only asks. Nothing may be written yet.
    expect(h.countOf('editMessageCaption')).toBe(1);
    expect(h.sent.at(-1)).toContain('permanent');
    expect(h.sent.at(-1)).toContain('one claim per collection');
  });

  it('spells out that the claim is permanent and one per collection', async () => {
    const h = harness();
    await h.send('/start drop');
    await h.press('c', FIRST_MESSAGE);

    const prompt = h.sent.at(-1) ?? '';
    expect(prompt).toContain('locked to you');
    expect(prompt).toContain('cannot swap it later');
  });

  it('keeps the confirmation on the same message rather than sending a new one', async () => {
    const h = harness();
    await h.send('/start drop');
    await h.press('c', FIRST_MESSAGE);

    expect(h.countOf('sendPhoto')).toBe(1);
    const edits = h.calls.filter((call) => call.method === 'editMessageCaption');
    expect(edits[0]?.messageId).toBe(FIRST_MESSAGE);
  });

  it('goes back to rolling when the member declines', async () => {
    const h = harness();
    await h.send('/start drop');
    await h.press('c', FIRST_MESSAGE);
    await h.press('x', FIRST_MESSAGE);

    expect(h.sent.at(-1)).toContain('Not claimed');
    // The roll survives: declining is not the same as losing the combination.
    const session = await h.sessions.get(555, 1);
    expect(session?.traitIds).toHaveLength(2);
  });

  it('does not treat a confirmation press as a reroll', async () => {
    const h = harness();
    await h.send('/start drop');
    const before = (await h.sessions.get(555, 1))?.traitIds;

    await h.press('c', FIRST_MESSAGE);

    const after = (await h.sessions.get(555, 1))?.traitIds;
    expect(after).toEqual(before);
  });
});

describe('claim confirmation with no session', () => {
  it('refuses a confirm press that has no roll behind it', async () => {
    const h = harness();
    await h.press('k', 7777);
    expect(h.sent.at(-1)).toContain('expired');
  });
});
