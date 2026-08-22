import { describe, expect, it } from 'vitest';
import {
  clampPage,
  collectionPage,
  COLLECTION_PAGE_SIZE,
  pageCountFor,
} from '../../src/core/collection.js';
import type { CollectionEntry } from '../../src/core/db/claim-repository.js';

function entries(count: number): CollectionEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    projectSlug: `drop-${String(i)}`,
    projectName: `Drop ${String(i)}`,
    editionNumber: i + 1,
    tier: i === 0 ? ('legendary' as const) : ('open' as const),
    claimedAt: new Date(Date.UTC(2026, 0, i + 1)),
  }));
}

describe('pageCountFor', () => {
  it('reports one page for an empty collection rather than zero', () => {
    // Zero pages would be a special case at every call site.
    expect(pageCountFor(0)).toBe(1);
  });

  it('fills a page before starting another', () => {
    expect(pageCountFor(1)).toBe(1);
    expect(pageCountFor(COLLECTION_PAGE_SIZE)).toBe(1);
    expect(pageCountFor(COLLECTION_PAGE_SIZE + 1)).toBe(2);
    expect(pageCountFor(COLLECTION_PAGE_SIZE * 3)).toBe(3);
  });
});

describe('clampPage', () => {
  it('never returns a page that does not exist', () => {
    expect(clampPage(-5, 3)).toBe(0);
    expect(clampPage(0, 3)).toBe(0);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(99, 3)).toBe(2);
    expect(clampPage(Number.NaN, 3)).toBe(0);
  });
});

describe('collectionPage', () => {
  it('returns the slice belonging to the requested page', () => {
    const all = entries(COLLECTION_PAGE_SIZE * 2 + 3);

    const first = collectionPage(all, 0);
    expect(first.entries).toHaveLength(COLLECTION_PAGE_SIZE);
    expect(first.entries[0]?.editionNumber).toBe(1);

    const last = collectionPage(all, 2);
    expect(last.entries).toHaveLength(3);
    expect(last.entries[0]?.editionNumber).toBe(COLLECTION_PAGE_SIZE * 2 + 1);
  });

  it('reports where the page sits and how many there are', () => {
    const page = collectionPage(entries(COLLECTION_PAGE_SIZE + 1), 1);
    expect(page.pageIndex).toBe(1);
    expect(page.pageCount).toBe(2);
    expect(page.total).toBe(COLLECTION_PAGE_SIZE + 1);
  });

  it('clamps a stale page request to the last page', () => {
    const page = collectionPage(entries(3), 99);
    expect(page.pageIndex).toBe(0);
    expect(page.entries).toHaveLength(3);
  });

  it('handles an empty collection without a special case', () => {
    const page = collectionPage([], 0);
    expect(page.entries).toEqual([]);
    expect(page.pageCount).toBe(1);
    expect(page.total).toBe(0);
  });

  it('covers every entry exactly once across all pages', () => {
    const all = entries(COLLECTION_PAGE_SIZE * 2 + 3);
    const seen: number[] = [];

    for (let p = 0; p < pageCountFor(all.length); p += 1) {
      seen.push(...collectionPage(all, p).entries.map((entry) => entry.editionNumber));
    }

    expect(seen).toEqual(all.map((entry) => entry.editionNumber));
  });
});
