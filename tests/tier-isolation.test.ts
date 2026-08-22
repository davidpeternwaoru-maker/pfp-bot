import { describe, expect, it } from 'vitest';
import { buildTraitPack, openPoolCapacity, openTraits } from '../src/render/pack.js';
import { selectOpenCombination } from '../src/render/select.js';
import { drawUnclaimed } from '../src/roll/pool.js';
import { cycleSlot, resolveCombination } from '../src/roll/cycle.js';
import { seededRandom, trait } from './helpers/fixtures.js';
import type { TraitRecord } from '../src/render/types.js';

/**
 * Reserved artwork must be unreachable by rolling, through every path that can
 * put a trait in front of a member. Tested as one suite rather than scattered
 * across the modules, because the guarantee is what matters and it only holds
 * if every one of them keeps it.
 */

const canvas = { width: 32, height: 32 } as const;

/** Each slot mixes open, gated and legendary options. */
const PACK = buildTraitPack({
  projectId: 1,
  canvas,
  traits: [
    trait({ id: 1, slot: 'background', layerOrder: 0, tier: 'open' }),
    trait({ id: 2, slot: 'background', layerOrder: 0, tier: 'open' }),
    trait({ id: 3, slot: 'background', layerOrder: 0, tier: 'legendary' }),
    trait({ id: 4, slot: 'background', layerOrder: 0, tier: 'gated' }),
    trait({ id: 5, slot: 'body', layerOrder: 10, tier: 'open' }),
    trait({ id: 6, slot: 'body', layerOrder: 10, tier: 'open' }),
    trait({ id: 7, slot: 'body', layerOrder: 10, tier: 'legendary' }),
    trait({ id: 8, slot: 'hat', layerOrder: 20, tier: 'open' }),
    trait({ id: 9, slot: 'hat', layerOrder: 20, tier: 'gated' }),
  ],
  exclusions: [],
});

const RESERVED_IDS = new Set([3, 4, 7, 9]);

/**
 * Collects offenders instead of asserting per trait.
 *
 * Calling expect() inside a 50,000-iteration loop costs seconds and reports
 * only that one boolean was wrong. Gathering violations keeps the loop cheap
 * and names the trait that escaped.
 */
function reservedEscapes(traits: readonly TraitRecord[]): string[] {
  const escapes: string[] = [];
  for (const picked of traits) {
    if (picked.tier !== 'open' || RESERVED_IDS.has(picked.id)) {
      escapes.push(`${picked.slot}/${picked.name} (id ${String(picked.id)}, ${picked.tier})`);
    }
  }
  return escapes;
}

describe('the random selector', () => {
  it('never returns a reserved trait over 50,000 samples', () => {
    const random = seededRandom(20260822);
    const escapes: string[] = [];

    for (let i = 0; i < 50_000; i += 1) {
      escapes.push(...reservedEscapes(selectOpenCombination(PACK, random)));
    }

    expect(escapes).toEqual([]);
  });

  it('covers every open option, so the filter is not just excluding everything', () => {
    const random = seededRandom(7);
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i += 1) {
      for (const picked of selectOpenCombination(PACK, random)) {
        seen.add(picked.id);
      }
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 5, 6, 8]);
  });
});

describe('the pool draw', () => {
  it('never draws a reserved trait, whether it lands randomly or by sweep', () => {
    const escapes: string[] = [];
    let drawnCount = 0;

    for (let i = 0; i < 2_000; i += 1) {
      // randomAttempts 0 on half the runs forces the enumeration path, which
      // builds combinations by index rather than by weighted choice.
      const outcome = drawUnclaimed({
        pack: PACK,
        isClaimed: () => false,
        random: seededRandom(i),
        randomAttempts: i % 2 === 0 ? 12 : 0,
      });
      if (outcome.kind === 'drawn') {
        drawnCount += 1;
        escapes.push(...reservedEscapes(outcome.traits));
      }
    }

    expect(drawnCount).toBe(2_000);
    expect(escapes).toEqual([]);
  });
});

describe('the slot cycler', () => {
  it('never cycles into a reserved trait', () => {
    let current = resolveCombination(PACK, [1, 5, 8]);
    expect(current).not.toBeNull();

    // Walk every slot round several full cycles.
    const escapes: string[] = [];
    for (let step = 0; step < 300; step += 1) {
      const slotIndex = step % PACK.slots.length;
      const result = cycleSlot(PACK, current ?? [], slotIndex);
      expect(result).not.toBeNull();
      if (result === null) {
        return;
      }
      escapes.push(...reservedEscapes(result.traits));
      current = result.traits;
    }

    expect(escapes).toEqual([]);
  });

  it('cannot be pushed into a reserved trait by starting from one', () => {
    // A member holding an awarded legendary who presses a slot button must be
    // moved onto open options, never round the reserved ones.
    const holding = resolveCombination(PACK, [3, 5, 8]);
    expect(holding).not.toBeNull();

    const result = cycleSlot(PACK, holding ?? [], 0);
    expect(result?.traits[0]?.tier).toBe('open');
  });
});

describe('capacity', () => {
  it('counts only what can actually be rolled', () => {
    // 2 open backgrounds x 2 open bodies x 1 open hat.
    expect(openPoolCapacity(PACK)).toBe(4);
  });

  it('ignores reserved options when counting a slot', () => {
    const background = PACK.slots[0];
    expect(background?.traits.length).toBe(4);
    expect(openTraits(background!).length).toBe(2);
  });
});
