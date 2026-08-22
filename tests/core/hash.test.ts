import { describe, expect, it } from 'vitest';
import { combinationHash, contentHash } from '../../src/core/render/hash.js';

describe('combinationHash', () => {
  it('is identical regardless of the order the ids arrive in', () => {
    const canonical = combinationHash([1, 2, 3, 4]);
    expect(combinationHash([4, 3, 2, 1])).toBe(canonical);
    expect(combinationHash([3, 1, 4, 2])).toBe(canonical);
    expect(combinationHash([2, 4, 1, 3])).toBe(canonical);
  });

  it('is stable across calls — it is what the unique constraint stores', () => {
    expect(combinationHash([10, 20, 30])).toBe(combinationHash([10, 20, 30]));
  });

  it('is a hex sha-256 digest', () => {
    expect(combinationHash([7])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates combinations that differ by a single trait', () => {
    expect(combinationHash([1, 2, 3])).not.toBe(combinationHash([1, 2, 4]));
  });

  it('does not collide between a multi-digit id and its digits', () => {
    // Guards the join separator: [1, 23] and [12, 3] must not hash alike.
    expect(combinationHash([1, 23])).not.toBe(combinationHash([12, 3]));
  });

  it('rejects a duplicate id, which would mean two options from one slot', () => {
    expect(() => combinationHash([5, 5])).toThrow(/duplicate/i);
  });

  it.each([[[]], [[0]], [[-1]], [[1.5]], [[Number.NaN]]])(
    'rejects the malformed id list %j',
    (ids: number[]) => {
      expect(() => combinationHash(ids)).toThrow(TypeError);
    },
  );
});

describe('contentHash', () => {
  it('changes when a single byte changes', () => {
    const a = contentHash(Uint8Array.from([1, 2, 3]));
    const b = contentHash(Uint8Array.from([1, 2, 4]));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for identical bytes', () => {
    expect(contentHash(Uint8Array.from([9, 9, 9]))).toBe(contentHash(Uint8Array.from([9, 9, 9])));
  });
});
