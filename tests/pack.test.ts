import { describe, expect, it } from 'vitest';
import { buildTraitPack, openPoolCapacity, openTraits } from '../src/render/pack.js';
import { TraitPackError } from '../src/render/errors.js';
import { trait } from './helpers/fixtures.js';

const canvas = { width: 1000, height: 1000 } as const;

function pack(traits: Parameters<typeof buildTraitPack>[0]['traits'], exclusions = []) {
  return buildTraitPack({ projectId: 1, canvas, traits, exclusions });
}

describe('buildTraitPack', () => {
  it('orders slots bottom to top by layerOrder', () => {
    const built = pack([
      trait({ slot: 'hat', layerOrder: 30 }),
      trait({ slot: 'background', layerOrder: 0 }),
      trait({ slot: 'eyes', layerOrder: 20 }),
      trait({ slot: 'body', layerOrder: 10 }),
    ]);

    expect(built.slots.map((s) => s.slot)).toEqual(['background', 'body', 'eyes', 'hat']);
    expect(built.slots.map((s) => s.layerOrder)).toEqual([0, 10, 20, 30]);
  });

  it('groups every option of a slot together, sorted by id', () => {
    const built = pack([
      trait({ id: 3, slot: 'eyes', layerOrder: 10 }),
      trait({ id: 1, slot: 'eyes', layerOrder: 10 }),
      trait({ id: 2, slot: 'eyes', layerOrder: 10 }),
      trait({ id: 9, slot: 'background', layerOrder: 0 }),
    ]);

    const eyes = built.slots.find((s) => s.slot === 'eyes');
    expect(eyes?.traits.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('rejects a slot whose options disagree on layerOrder', () => {
    expect(() =>
      pack([
        trait({ slot: 'eyes', layerOrder: 10 }),
        trait({ slot: 'eyes', layerOrder: 11 }),
        trait({ slot: 'background', layerOrder: 0 }),
      ]),
    ).toThrow(TraitPackError);
  });

  it('rejects two slots sharing a layerOrder, which makes stacking ambiguous', () => {
    expect(() =>
      pack([trait({ slot: 'eyes', layerOrder: 5 }), trait({ slot: 'hat', layerOrder: 5 })]),
    ).toThrow(/ambiguous/);
  });

  it('rejects a rarityWeight below 1, which would make an option unreachable', () => {
    expect(() => pack([trait({ slot: 'eyes', rarityWeight: 0 })])).toThrow(/rarityWeight/);
  });

  it('rejects duplicate trait ids', () => {
    expect(() =>
      pack([
        trait({ id: 4, slot: 'eyes', layerOrder: 0 }),
        trait({ id: 4, slot: 'hat', layerOrder: 1 }),
      ]),
    ).toThrow(/duplicate trait ids/);
  });

  it('rejects an exclusion naming a trait outside the pack', () => {
    expect(() =>
      buildTraitPack({
        projectId: 1,
        canvas,
        traits: [trait({ id: 1, slot: 'eyes' })],
        exclusions: [{ traitAId: 1, traitBId: 999 }],
      }),
    ).toThrow(/outside this pack/);
  });

  it('rejects an empty pack and a zero-sized canvas', () => {
    expect(() => pack([])).toThrow(TraitPackError);
    expect(() =>
      buildTraitPack({
        projectId: 1,
        canvas: { width: 0, height: 100 },
        traits: [trait({ slot: 'eyes' })],
        exclusions: [],
      }),
    ).toThrow(/canvas size/);
  });
});

describe('openPoolCapacity', () => {
  it('multiplies the option counts of every slot', () => {
    const built = pack([
      trait({ slot: 'background', layerOrder: 0 }),
      trait({ slot: 'background', layerOrder: 0 }),
      trait({ slot: 'background', layerOrder: 0 }),
      trait({ slot: 'eyes', layerOrder: 10 }),
      trait({ slot: 'eyes', layerOrder: 10 }),
    ]);

    expect(openPoolCapacity(built)).toBe(6);
  });

  it('counts only open-tier options', () => {
    const built = pack([
      trait({ slot: 'background', layerOrder: 0 }),
      trait({ slot: 'background', layerOrder: 0 }),
      trait({ slot: 'eyes', layerOrder: 10 }),
      trait({ slot: 'eyes', layerOrder: 10, tier: 'legendary' }),
      trait({ slot: 'eyes', layerOrder: 10, tier: 'gated' }),
    ]);

    expect(openTraits(built.slots[1]!).length).toBe(1);
    expect(openPoolCapacity(built)).toBe(2);
  });

  it('is zero when a slot has no open option, because no roll can complete', () => {
    const built = pack([
      trait({ slot: 'background', layerOrder: 0 }),
      trait({ slot: 'eyes', layerOrder: 10, tier: 'legendary' }),
    ]);

    expect(openPoolCapacity(built)).toBe(0);
  });
});
