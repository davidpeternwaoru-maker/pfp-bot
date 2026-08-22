import { describe, expect, it } from 'vitest';
import {
  buildExclusionIndex,
  findExcludedPair,
  hasExcludedPair,
} from '../src/render/exclusions.js';

describe('exclusion checker', () => {
  const index = buildExclusionIndex([
    { traitAId: 3, traitBId: 7 },
    { traitAId: 10, traitBId: 2 },
  ]);

  it('rejects a combination containing an excluded pair', () => {
    expect(hasExcludedPair(index, [1, 3, 7, 9])).toBe(true);
  });

  it('rejects it whichever way round the pair appears', () => {
    expect(hasExcludedPair(index, [7, 3])).toBe(true);
    expect(hasExcludedPair(index, [3, 7])).toBe(true);
    expect(hasExcludedPair(index, [2, 10])).toBe(true);
  });

  it('accepts a combination holding only one half of a pair', () => {
    expect(hasExcludedPair(index, [1, 3, 9])).toBe(false);
    expect(hasExcludedPair(index, [7, 2])).toBe(false);
  });

  it('accepts a combination with no listed pair', () => {
    expect(hasExcludedPair(index, [1, 4, 5, 6])).toBe(false);
  });

  it('names which two traits clashed', () => {
    expect(findExcludedPair(index, [9, 7, 3])).toEqual({ traitAId: 7, traitBId: 3 });
    expect(findExcludedPair(index, [9, 8])).toBeUndefined();
  });

  it('treats an empty exclusion list as no restrictions', () => {
    expect(hasExcludedPair(buildExclusionIndex([]), [1, 2, 3])).toBe(false);
  });
});
