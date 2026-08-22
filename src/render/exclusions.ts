import type { ExclusionPair } from './types.js';

/** Order-insensitive key: an exclusion applies whichever way round it was stored. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export type ExclusionIndex = ReadonlySet<string>;

export function buildExclusionIndex(pairs: readonly ExclusionPair[]): ExclusionIndex {
  return new Set(pairs.map((pair) => pairKey(pair.traitAId, pair.traitBId)));
}

/**
 * Returns the first excluded pair present in the combination, or undefined.
 * Returning the pair rather than a boolean lets callers say which two traits
 * clashed instead of only that something did.
 */
export function findExcludedPair(
  index: ExclusionIndex,
  traitIds: readonly number[],
): ExclusionPair | undefined {
  for (let i = 0; i < traitIds.length; i += 1) {
    for (let j = i + 1; j < traitIds.length; j += 1) {
      const a = traitIds[i];
      const b = traitIds[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      if (index.has(pairKey(a, b))) {
        return { traitAId: a, traitBId: b };
      }
    }
  }
  return undefined;
}

export function hasExcludedPair(index: ExclusionIndex, traitIds: readonly number[]): boolean {
  return findExcludedPair(index, traitIds) !== undefined;
}
