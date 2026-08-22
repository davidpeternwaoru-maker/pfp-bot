import { describe, expect, it } from 'vitest';
import {
  clampPage,
  collectionKeyboard,
  COLLECTION_PAGE_SIZE,
  pageCountFor,
  renderCollectionPage,
} from '../src/bot/collection.js';
import { parseCollectionPage } from '../src/bot/callback-data.js';
import type { CollectionEntry } from '../src/db/claim-repository.js';

function entries(count: number): CollectionEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    projectSlug: `drop-${String(i)}`,
    projectName: `Drop ${String(i)}`,
    editionNumber: i + 1,
    tier: i === 0 ? ('legendary' as const) : ('open' as const),
    claimedAt: new Date(Date.UTC(2026, 0, i + 1)),
  }));
}

describe('renderCollectionPage', () => {
  it('lists project, edition, date and tier', () => {
    const page = renderCollectionPage(entries(1), 0);
    expect(page.text).toContain('Drop 0');
    expect(page.text).toContain('#1');
    expect(page.text).toContain('2026-01-01');
    expect(page.text).toContain('legendary');
  });

  it('does not badge an ordinary open claim', () => {
    const page = renderCollectionPage([entries(2)[1] as CollectionEntry], 0);
    expect(page.text).not.toContain('legendary');
    expect(page.text).not.toContain('open');
  });

  it('says so plainly when there is nothing yet', () => {
    const page = renderCollectionPage([], 0);
    expect(page.text).toContain('not claimed anything yet');
    expect(page.pageCount).toBe(1);
  });

  it('keeps one page when everything fits', () => {
    const page = renderCollectionPage(entries(COLLECTION_PAGE_SIZE), 0);
    expect(page.pageCount).toBe(1);
    expect(collectionKeyboard(page)).toBeUndefined();
  });

  it('paginates once it does not fit', () => {
    const all = entries(COLLECTION_PAGE_SIZE * 2 + 1);
    const page = renderCollectionPage(all, 0);
    expect(page.pageCount).toBe(3);
    expect(page.text).toContain('Page 1 of 3');
  });

  it('shows every claim exactly once across its pages', () => {
    const all = entries(COLLECTION_PAGE_SIZE * 2 + 3);
    const seen = new Set<string>();

    for (let p = 0; p < pageCountFor(all.length); p += 1) {
      for (const line of renderCollectionPage(all, p).text.split('\n')) {
        const match = /^#(\d+) · /.exec(line);
        if (match?.[1] !== undefined) {
          expect(seen.has(match[1])).toBe(false);
          seen.add(match[1]);
        }
      }
    }

    expect(seen.size).toBe(all.length);
  });

  it('offers only the page directions that exist', () => {
    const all = entries(COLLECTION_PAGE_SIZE * 3);

    const first = collectionKeyboard(renderCollectionPage(all, 0));
    expect(JSON.stringify(first)).toContain('Next');
    expect(JSON.stringify(first)).not.toContain('Previous');

    const last = collectionKeyboard(renderCollectionPage(all, 2));
    expect(JSON.stringify(last)).toContain('Previous');
    expect(JSON.stringify(last)).not.toContain('Next');
  });

  it('clamps a page beyond the end instead of showing nothing', () => {
    const all = entries(3);
    const page = renderCollectionPage(all, 99);
    expect(page.pageIndex).toBe(0);
    expect(page.text).toContain('#1');
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

describe('parseCollectionPage', () => {
  it('accepts a well-formed page action', () => {
    expect(parseCollectionPage('g0')).toBe(0);
    expect(parseCollectionPage('g12')).toBe(12);
  });

  it('rejects anything else, so it cannot be confused with a rolling action', () => {
    expect(parseCollectionPage(undefined)).toBeNull();
    expect(parseCollectionPage('')).toBeNull();
    expect(parseCollectionPage('g')).toBeNull();
    expect(parseCollectionPage('g-1')).toBeNull();
    expect(parseCollectionPage('gx')).toBeNull();
    expect(parseCollectionPage('r')).toBeNull();
    expect(parseCollectionPage('s1')).toBeNull();
    expect(parseCollectionPage('g1;drop')).toBeNull();
    expect(parseCollectionPage(`g${'9'.repeat(40)}`)).toBeNull();
  });
});
