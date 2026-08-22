import { describe, expect, it } from 'vitest';
import { buildTraitPack } from '../src/render/pack.js';
import { selectOpenCombination, weightedPick } from '../src/render/select.js';
import { EmptySlotError } from '../src/render/errors.js';
import { seededRandom, trait } from './helpers/fixtures.js';

const canvas = { width: 100, height: 100 } as const;

describe('weightedPick', () => {
  it('follows the declared weights over many samples', () => {
    const items = [
      { name: 'common', weight: 90 },
      { name: 'rare', weight: 9 },
      { name: 'ultra', weight: 1 },
    ];
    const random = seededRandom(1234);
    const counts = new Map<string, number>();
    const samples = 100_000;

    for (let i = 0; i < samples; i += 1) {
      const picked = weightedPick(items, (item) => item.weight, random);
      counts.set(picked.name, (counts.get(picked.name) ?? 0) + 1);
    }

    // Tolerances are wide enough that only a genuinely wrong weighting fails.
    expect((counts.get('common') ?? 0) / samples).toBeCloseTo(0.9, 2);
    expect((counts.get('rare') ?? 0) / samples).toBeCloseTo(0.09, 2);
    expect((counts.get('ultra') ?? 0) / samples).toBeCloseTo(0.01, 2);
  });

  it('can still return the heaviest and the lightest option', () => {
    const items = [
      { name: 'a', weight: 1 },
      { name: 'b', weight: 999 },
    ];
    const random = seededRandom(7);
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      seen.add(weightedPick(items, (item) => item.weight, random).name);
    }
    expect([...seen].sort()).toEqual(['a', 'b']);
  });

  it('never returns an item whose share of the weight is zero-length', () => {
    // random() === 0 must land on the first item, not before it.
    const items = ['first', 'second'];
    expect(
      weightedPick(
        items,
        () => 1,
        () => 0,
      ),
    ).toBe('first');
  });
});

describe('selectOpenCombination', () => {
  const built = buildTraitPack({
    projectId: 1,
    canvas,
    traits: [
      trait({ id: 1, slot: 'background', layerOrder: 0 }),
      trait({ id: 2, slot: 'background', layerOrder: 0 }),
      trait({ id: 3, slot: 'body', layerOrder: 10 }),
      trait({ id: 4, slot: 'eyes', layerOrder: 20 }),
      trait({ id: 5, slot: 'eyes', layerOrder: 20, tier: 'legendary' }),
      trait({ id: 6, slot: 'eyes', layerOrder: 20, tier: 'gated' }),
    ],
    exclusions: [],
  });

  it('returns exactly one trait per slot, in layer order', () => {
    const combination = selectOpenCombination(built, seededRandom(42));
    expect(combination.map((t) => t.slot)).toEqual(['background', 'body', 'eyes']);
    expect(combination.map((t) => t.layerOrder)).toEqual([0, 10, 20]);
  });

  it('never returns a gated or legendary trait, over many samples', () => {
    const random = seededRandom(99);
    for (let i = 0; i < 20_000; i += 1) {
      for (const picked of selectOpenCombination(built, random)) {
        expect(picked.tier).toBe('open');
      }
    }
  });

  it('throws rather than returning a partial combination when a slot is empty', () => {
    const reservedOnly = buildTraitPack({
      projectId: 1,
      canvas,
      traits: [
        trait({ id: 1, slot: 'background', layerOrder: 0 }),
        trait({ id: 2, slot: 'eyes', layerOrder: 10, tier: 'legendary' }),
      ],
      exclusions: [],
    });

    expect(() => selectOpenCombination(reservedOnly, seededRandom(1))).toThrow(EmptySlotError);
  });
});
