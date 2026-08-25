import { describe, expect, it } from 'vitest';
import {
  answer,
  attachReference,
  finish,
  promptFor,
  skip,
  startDraft,
} from '../../src/core/commission/draft.js';
import type { CommissionDraft } from '../../src/core/commission/draft.js';
import { createInMemoryDraftStore } from '../../src/core/commission/draft-store.js';
import { MAX_TEXT_LENGTH } from '../../src/core/commission/brief.js';

/**
 * The questionnaire.
 *
 * Two properties carry it. A member is corrected at the point of entry rather
 * than at the end, and an interrupted flow resumes exactly where it stopped —
 * which is only true because the draft *is* the position, so restoring one
 * restores the other.
 */

const SLOTS = ['hat', 'eyes'] as const;

function walk(draft: CommissionDraft, value: string): CommissionDraft {
  const result = answer(draft, value, SLOTS);
  if (!result.ok) {
    throw new Error(`unexpected rejection: ${result.problem.message}`);
  }
  return result.draft;
}

describe('walking the questionnaire', () => {
  it('asks one thing at a time, in order', () => {
    let draft = startDraft(1, 1);
    expect(promptFor(draft, SLOTS).step).toBe('slot');

    draft = walk(draft, 'hat');
    expect(promptFor(draft, SLOTS).step).toBe('colour');

    draft = walk(draft, 'gold');
    expect(promptFor(draft, SLOTS).step).toBe('text');

    draft = walk(draft, 'DAVID');
    expect(promptFor(draft, SLOTS).step).toBe('note');

    draft = walk(draft, 'Tilted slightly.');
    expect(promptFor(draft, SLOTS).step).toBe('confirm');
  });

  it("offers the project's own slots, not a fixed list", () => {
    const prompt = promptFor(startDraft(1, 1), ['beak', 'tail']);
    expect(prompt.step === 'slot' && prompt.options).toEqual(['beak', 'tail']);
  });

  it('summarises everything before anything is ordered', () => {
    let draft = startDraft(1, 1);
    draft = walk(draft, 'hat');
    draft = walk(draft, 'gold');
    draft = walk(draft, 'DAVID');
    draft = walk(draft, 'Please tilt it.');

    const prompt = promptFor(draft, SLOTS);
    expect(prompt.step).toBe('confirm');
    if (prompt.step === 'confirm') {
      // Nobody should be able to pay for something they have not been shown.
      expect(prompt.summary).toEqual({
        slot: 'hat',
        colour: 'gold',
        textContent: 'DAVID',
        note: 'Please tilt it.',
        hasReference: false,
      });
    }
  });

  it('produces a brief that matches what was summarised', () => {
    let draft = startDraft(1, 1);
    draft = walk(draft, 'eyes');
    draft = walk(draft, 'teal');
    draft = walk(draft, 'HI');
    draft = walk(draft, 'thanks');

    const finished = finish(draft, SLOTS);
    expect(finished.ok).toBe(true);
    if (finished.ok) {
      expect(finished.brief).toEqual({
        slot: 'eyes',
        colour: 'teal',
        textContent: 'HI',
        note: 'thanks',
        referencePath: null,
      });
    }
  });
});

describe('correcting at the point of entry', () => {
  it('refuses a bad answer and leaves the member on the same question', () => {
    const draft = startDraft(1, 1);
    const result = answer(draft, 'nose', SLOTS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Named and fixable, with the question still in front of them.
      expect(result.problem.field).toBe('slot');
      expect(result.problem.message).toContain('hat');
    }
    // And the draft has not moved on.
    expect(promptFor(draft, SLOTS).step).toBe('slot');
  });

  it('refuses text that is too long, saying by how much', () => {
    const draft = walk(walk(startDraft(1, 1), 'hat'), 'gold');
    const result = answer(draft, 'x'.repeat(MAX_TEXT_LENGTH + 6), SLOTS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.field).toBe('textContent');
      expect(result.problem.message).toContain(String(MAX_TEXT_LENGTH + 6));
    }
  });

  it('refuses a colour that is not on the palette', () => {
    const draft = walk(startDraft(1, 1), 'hat');
    const result = answer(draft, 'burnt sienna', SLOTS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.field).toBe('colour');
    }
  });

  it('applies the same rule at entry that submission applies', () => {
    // Two copies of a validation rule eventually disagree, and the way that
    // shows up is a member being accepted step by step and refused at the end.
    const draft = walk(walk(startDraft(1, 1), 'hat'), 'gold');
    const emoji = 'crown 👑';

    expect(answer(draft, emoji, SLOTS).ok).toBe(false);
    expect(finish({ ...draft, textContent: emoji, step: 'confirm' }, SLOTS).ok).toBe(false);
  });
});

describe('skipping', () => {
  it('lets the optional questions be skipped', () => {
    let draft = walk(startDraft(1, 1), 'hat');

    for (const expected of ['text', 'note', 'confirm'] as const) {
      const result = skip(draft);
      expect(result.ok).toBe(true);
      if (result.ok) {
        draft = result.draft;
      }
      expect(promptFor(draft, SLOTS).step).toBe(expected);
    }
  });

  it('will not skip the slot, because there is no commission without one', () => {
    const result = skip(startDraft(1, 1));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.field).toBe('slot');
    }
  });

  it('produces a brief with only the slot when everything else is skipped', () => {
    let draft = walk(startDraft(1, 1), 'hat');
    for (let i = 0; i < 3; i += 1) {
      const result = skip(draft);
      if (result.ok) {
        draft = result.draft;
      }
    }

    const finished = finish(draft, SLOTS);
    expect(finished.ok).toBe(true);
    if (finished.ok) {
      expect(finished.brief).toEqual({
        slot: 'hat',
        colour: null,
        textContent: null,
        note: null,
        referencePath: null,
      });
    }
  });
});

describe('re-checking at the end', () => {
  it('refuses an order for a slot the project has since withdrawn', () => {
    // The eligible slots can change while somebody is answering. An order
    // placed against a withdrawn slot is an order nobody can produce.
    let draft = walk(startDraft(1, 1), 'hat');
    draft = walk(draft, 'gold');

    const finished = finish(draft, ['eyes']);
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.problems[0]?.field).toBe('slot');
    }
  });
});

describe('a reference image', () => {
  it('can be attached at any point without disturbing the position', () => {
    const draft = walk(startDraft(1, 1), 'hat');
    const withReference = attachReference(draft, 'commissions/1/ref.png');

    expect(withReference.referencePath).toBe('commissions/1/ref.png');
    // Attaching is not answering: the question they were on is still theirs.
    expect(promptFor(withReference, SLOTS).step).toBe(promptFor(draft, SLOTS).step);
  });
});

describe('resuming an interrupted questionnaire', () => {
  it('comes back to the exact question it left on', async () => {
    const store = createInMemoryDraftStore();
    const draft = walk(walk(startDraft(7, 3), 'hat'), 'gold');
    await store.set(draft);

    // They wander off. Later, they come back.
    const resumed = await store.get(7, 3);

    expect(resumed).toBeDefined();
    expect(promptFor(resumed as CommissionDraft, SLOTS).step).toBe('text');
    // And nothing already answered has to be answered again.
    expect(resumed?.slot).toBe('hat');
    expect(resumed?.colour).toBe('gold');
  });

  it("keeps one member's draft away from another's", async () => {
    const store = createInMemoryDraftStore();
    await store.set(walk(startDraft(1, 1), 'hat'));
    await store.set(walk(startDraft(2, 1), 'eyes'));

    expect((await store.get(1, 1))?.slot).toBe('hat');
    expect((await store.get(2, 1))?.slot).toBe('eyes');
  });

  it('keeps drafts for different projects apart', async () => {
    const store = createInMemoryDraftStore();
    await store.set(walk(startDraft(1, 1), 'hat'));
    await store.set(walk(startDraft(1, 2), 'eyes'));

    expect((await store.get(1, 1))?.slot).toBe('hat');
    expect((await store.get(1, 2))?.slot).toBe('eyes');
  });

  it('holds a draft far longer than a roll, because answers cost effort', async () => {
    let clock = 0;
    const store = createInMemoryDraftStore({ now: () => clock });
    await store.set(walk(startDraft(1, 1), 'hat'));

    // An hour later — where a roll would have expired — the answers are still
    // there. Making somebody answer four questions again ends orders.
    clock = 60 * 60 * 1000 + 1;
    expect(await store.get(1, 1)).toBeDefined();

    clock = 24 * 60 * 60 * 1000 + 1;
    expect(await store.get(1, 1)).toBeUndefined();
  });

  it('forgets a draft that was deliberately abandoned', async () => {
    const store = createInMemoryDraftStore();
    await store.set(walk(startDraft(1, 1), 'hat'));
    await store.clear(1, 1);

    expect(await store.get(1, 1)).toBeUndefined();
  });
});
