import { describe, expect, it } from 'vitest';
import { collisionAdvice } from '../../src/core/roll/collision.js';
import { combinationHash } from '../../src/core/render/hash.js';
import { buildTraitPack } from '../../src/core/render/pack.js';
import type { TraitPack, TraitRecord } from '../../src/core/render/types.js';

/**
 * A collision has to name a next tap.
 *
 * "Taken" on its own is a dead end, and a dead end is the one thing this
 * product does not ship. The advice is therefore a list of slots a single
 * change to which lands somewhere free — single, because a member is choosing
 * their next tap and a hint needing two simultaneous edits is not advice.
 */

const CANVAS = { width: 8, height: 8 } as const;

function trait(id: number, slot: string, layerOrder: number, name: string): TraitRecord {
  return {
    id,
    slot,
    name,
    layerOrder,
    imagePath: `${String(id)}.png`,
    rarityWeight: 1,
    tier: 'open',
  };
}

/** Two body options, two hat options, two eye options: eight combinations. */
function pack(exclusions: { traitAId: number; traitBId: number }[] = []): TraitPack {
  return buildTraitPack({
    projectId: 1,
    canvas: CANVAS,
    traits: [
      trait(1, 'body', 10, 'body-a'),
      trait(2, 'body', 10, 'body-b'),
      trait(3, 'hat', 20, 'hat-a'),
      trait(4, 'hat', 20, 'hat-b'),
      trait(5, 'eyes', 30, 'eyes-a'),
      trait(6, 'eyes', 30, 'eyes-b'),
    ],
    exclusions,
  });
}

function combination(p: TraitPack, ids: readonly number[]): readonly TraitRecord[] {
  return ids.map((id) => {
    const found = p.slots.flatMap((slot) => slot.traits).find((t) => t.id === id);
    if (found === undefined) {
      throw new Error(`fixture has no trait ${String(id)}`);
    }
    return found;
  });
}

function claimedSet(ids: readonly (readonly number[])[]): (hash: string) => boolean {
  const hashes = new Set(ids.map((combo) => combinationHash(combo)));
  return (hash) => hashes.has(hash);
}

describe('collisionAdvice', () => {
  it('names every slot a single change to which frees the combination', () => {
    const p = pack();
    // Only [1,3,5] is taken, so changing any one slot gets off it.
    const advice = collisionAdvice(p, combination(p, [1, 3, 5]), claimedSet([[1, 3, 5]]));

    expect(advice.stuck).toBe(false);
    // In pack order, so the wording matches the buttons on screen.
    expect(advice.freeingSlots).toEqual(['body', 'hat', 'eyes']);
  });

  it('leaves out a slot whose every alternative is also taken', () => {
    const p = pack();
    const advice = collisionAdvice(
      p,
      combination(p, [1, 3, 5]),
      // Changing the hat lands on [1,4,5], which is taken too. Changing the
      // body or the eyes still works.
      claimedSet([
        [1, 3, 5],
        [1, 4, 5],
      ]),
    );

    expect(advice.freeingSlots).toEqual(['body', 'eyes']);
    expect(advice.stuck).toBe(false);
  });

  it('reports stuck when no single change frees it', () => {
    const p = pack();
    const advice = collisionAdvice(
      p,
      combination(p, [1, 3, 5]),
      claimedSet([
        [1, 3, 5],
        [2, 3, 5],
        [1, 4, 5],
        [1, 3, 6],
      ]),
    );

    // Free combinations remain — [2,4,6] for one — but none is one tap away,
    // and saying otherwise would send them tapping at random.
    expect(advice.freeingSlots).toEqual([]);
    expect(advice.stuck).toBe(true);
  });

  it('does not offer a change that would break an exclusion', () => {
    // The only other hat cannot be worn with this body, so changing the hat is
    // not a move that exists, however free the result would be.
    const p = pack([{ traitAId: 1, traitBId: 4 }]);
    const advice = collisionAdvice(p, combination(p, [1, 3, 5]), claimedSet([[1, 3, 5]]));

    expect(advice.freeingSlots).not.toContain('hat');
    expect(advice.freeingSlots).toEqual(['body', 'eyes']);
  });

  it('treats a combination that does not fit the pack as stuck rather than guessing', () => {
    const p = pack();
    const advice = collisionAdvice(p, combination(p, [1, 3]), claimedSet([]));

    expect(advice.stuck).toBe(true);
    expect(advice.freeingSlots).toEqual([]);
  });
});
