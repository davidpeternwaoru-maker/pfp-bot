import { createHash } from 'node:crypto';

/**
 * Identity of a combination, and the value the (projectId, combinationHash)
 * unique constraint is built on.
 *
 * SHA-256 over the sorted id list. Sorting first is what makes this a hash of
 * the *set* of traits: if ordering could change the result, the same artwork
 * would hash two ways and the constraint would let a duplicate through.
 * A plain join of decimal ids keeps it stable across processes, restarts and
 * Node versions — no JSON key order, no locale, no object iteration order.
 */
export function combinationHash(traitIds: readonly number[]): string {
  if (traitIds.length === 0) {
    throw new TypeError('combinationHash requires at least one trait id');
  }

  for (const id of traitIds) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new TypeError(`combinationHash requires positive integer ids, received ${String(id)}`);
    }
  }

  const sorted = [...traitIds].sort((a, b) => a - b);

  // A repeated id means two options from one slot, which is not a combination.
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) {
      throw new TypeError(`combinationHash received a duplicate trait id: ${String(sorted[i])}`);
    }
  }

  return createHash('sha256').update(sorted.join(',')).digest('hex');
}

/** Identity of the rendered bytes, used to detect artwork drift after a claim. */
export function contentHash(image: Uint8Array): string {
  return createHash('sha256').update(image).digest('hex');
}
