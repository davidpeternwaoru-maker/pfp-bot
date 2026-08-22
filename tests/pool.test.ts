import { describe, expect, it } from 'vitest';
import { buildTraitPack } from '../src/render/pack.js';
import { combinationHash } from '../src/render/hash.js';
import { drawUnclaimed } from '../src/roll/pool.js';
import { cycleSlot, resolveCombination } from '../src/roll/cycle.js';
import { seededRandom, trait } from './helpers/fixtures.js';
import type { TraitPack } from '../src/render/types.js';

const canvas = { width: 32, height: 32 } as const;

/** A pack with `a` options in the lower slot and `b` in the upper one. */
function packOf(a: number, b: number, exclusions: { traitAId: number; traitBId: number }[] = []) {
  const traits = [];
  let id = 1;
  for (let i = 0; i < a; i += 1) {
    traits.push(trait({ id: id++, slot: 'background', layerOrder: 0 }));
  }
  for (let i = 0; i < b; i += 1) {
    traits.push(trait({ id: id++, slot: 'body', layerOrder: 10 }));
  }
  return buildTraitPack({ projectId: 1, canvas, traits, exclusions });
}

/** Every combination in a pack, as hashes. */
function allHashes(pack: TraitPack): string[] {
  const [lower, upper] = pack.slots;
  const hashes: string[] = [];
  for (const a of lower?.traits ?? []) {
    for (const b of upper?.traits ?? []) {
      hashes.push(combinationHash([a.id, b.id]));
    }
  }
  return hashes;
}

describe('drawUnclaimed', () => {
  it('returns a combination when the pool is empty of claims', () => {
    const pack = packOf(3, 3);
    const outcome = drawUnclaimed({ pack, isClaimed: () => false, random: seededRandom(1) });

    expect(outcome.kind).toBe('drawn');
    if (outcome.kind === 'drawn') {
      expect(outcome.traits).toHaveLength(2);
      expect(outcome.hash).toBe(combinationHash(outcome.traits.map((t) => t.id)));
    }
  });

  it('never returns something already claimed', () => {
    const pack = packOf(4, 4);
    const hashes = allHashes(pack);
    // Claim all but one, so random draws will nearly always miss.
    const free = hashes[7];
    const claimed = new Set(hashes.filter((h) => h !== free));

    for (let i = 0; i < 200; i += 1) {
      const outcome = drawUnclaimed({
        pack,
        isClaimed: (h) => claimed.has(h),
        random: seededRandom(i),
      });
      expect(outcome.kind).toBe('drawn');
      if (outcome.kind === 'drawn') {
        expect(outcome.hash).toBe(free);
      }
    }
  });

  it('reports exhaustion only after proving every combination is taken', () => {
    const pack = packOf(3, 3);
    const claimed = new Set(allHashes(pack));

    const outcome = drawUnclaimed({
      pack,
      isClaimed: (h) => claimed.has(h),
      random: seededRandom(5),
    });
    expect(outcome.kind).toBe('exhausted');
  });

  it('says undetermined rather than exhausted when it ran out of budget', () => {
    const pack = packOf(20, 20);
    // Everything claimed, but the sweep is only allowed to look at 10 of 400.
    const claimed = new Set(allHashes(pack));

    const outcome = drawUnclaimed({
      pack,
      isClaimed: (h) => claimed.has(h),
      random: seededRandom(3),
      randomAttempts: 2,
      maxEnumerated: 10,
    });

    // Claiming exhaustion here would tell members the collection is finished
    // when 390 combinations were never even looked at.
    expect(outcome.kind).toBe('undetermined');
  });

  it('terminates on a pool where every combination is excluded', () => {
    const pack = packOf(2, 2, [
      { traitAId: 1, traitBId: 3 },
      { traitAId: 1, traitBId: 4 },
      { traitAId: 2, traitBId: 3 },
      { traitAId: 2, traitBId: 4 },
    ]);

    const outcome = drawUnclaimed({ pack, isClaimed: () => false, random: seededRandom(9) });
    expect(outcome.kind).toBe('exhausted');
  });

  it('never returns a combination containing an excluded pair', () => {
    const pack = packOf(3, 3, [{ traitAId: 1, traitBId: 4 }]);

    for (let i = 0; i < 500; i += 1) {
      const outcome = drawUnclaimed({ pack, isClaimed: () => false, random: seededRandom(i) });
      if (outcome.kind === 'drawn') {
        const ids = outcome.traits.map((t) => t.id);
        expect(ids.includes(1) && ids.includes(4)).toBe(false);
      }
    }
  });

  it('treats a slot with no open option as an empty pool', () => {
    const pack = buildTraitPack({
      projectId: 1,
      canvas,
      traits: [
        trait({ id: 1, slot: 'background', layerOrder: 0 }),
        trait({ id: 2, slot: 'body', layerOrder: 10, tier: 'legendary' }),
      ],
      exclusions: [],
    });

    expect(drawUnclaimed({ pack, isClaimed: () => false }).kind).toBe('exhausted');
  });

  it('spreads draws across the pool instead of always handing out the same one', () => {
    const pack = packOf(5, 5);
    const hashes = allHashes(pack);
    // All but three claimed, so every draw goes through the sweep.
    const free = new Set([hashes[2], hashes[11], hashes[20]]);
    const claimed = new Set(hashes.filter((h) => !free.has(h)));

    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const outcome = drawUnclaimed({
        pack,
        isClaimed: (h) => claimed.has(h),
        random: seededRandom(i),
        randomAttempts: 0,
      });
      if (outcome.kind === 'drawn') {
        seen.add(outcome.hash);
      }
    }

    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('cycleSlot', () => {
  it('changes only the requested slot', () => {
    const pack = packOf(3, 3);
    const current = resolveCombination(pack, [1, 4]);
    expect(current).not.toBeNull();

    const result = cycleSlot(pack, current ?? [], 0);
    expect(result?.changed).toBe(true);
    expect(result?.traits[1]?.id).toBe(4);
    expect(result?.traits[0]?.id).not.toBe(1);
  });

  it('wraps around to the first option', () => {
    const pack = packOf(3, 3);
    const current = resolveCombination(pack, [3, 4]) ?? [];

    const result = cycleSlot(pack, current, 0);
    expect(result?.traits[0]?.id).toBe(1);
  });

  it('steps over an option that would create an excluded pair', () => {
    // Holding body=4; background option 2 clashes with it, so cycling from
    // background=1 must land on 3, not 2.
    const pack = packOf(3, 3, [{ traitAId: 2, traitBId: 4 }]);
    const current = resolveCombination(pack, [1, 4]) ?? [];

    const result = cycleSlot(pack, current, 0);
    expect(result?.traits[0]?.id).toBe(3);
  });

  it('reports unchanged when every other option in the slot clashes', () => {
    const pack = packOf(2, 2, [{ traitAId: 2, traitBId: 3 }]);
    const current = resolveCombination(pack, [1, 3]) ?? [];

    const result = cycleSlot(pack, current, 0);
    expect(result?.changed).toBe(false);
    expect(result?.traits.map((t) => t.id)).toEqual([1, 3]);
  });

  it('rejects a slot index outside the pack', () => {
    const pack = packOf(2, 2);
    const current = resolveCombination(pack, [1, 3]) ?? [];

    expect(cycleSlot(pack, current, 5)).toBeNull();
    expect(cycleSlot(pack, current, -1)).toBeNull();
  });
});

describe('resolveCombination', () => {
  it('returns null when a trait id is no longer in the pack', () => {
    const pack = packOf(2, 2);
    expect(resolveCombination(pack, [1, 999])).toBeNull();
  });

  it('returns null when the combination has the wrong number of slots', () => {
    const pack = packOf(2, 2);
    expect(resolveCombination(pack, [1])).toBeNull();
    expect(resolveCombination(pack, [1, 3, 3])).toBeNull();
  });
});
