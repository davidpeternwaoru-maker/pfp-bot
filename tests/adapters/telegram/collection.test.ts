import { describe, expect, it } from 'vitest';
import { collectionPage, COLLECTION_PAGE_SIZE } from '../../../src/core/collection.js';
import {
  collectionKeyboard,
  formatCollectionPage,
} from '../../../src/adapters/telegram/collection.js';
import { parseCollectionPage } from '../../../src/adapters/telegram/callback-data.js';
import type { CollectionEntry } from '../../../src/core/db/claim-repository.js';

function entries(count: number): CollectionEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    projectSlug: `drop-${String(i)}`,
    projectName: `Drop ${String(i)}`,
    editionNumber: i + 1,
    tier: i === 0 ? ('legendary' as const) : ('open' as const),
    claimedAt: new Date(Date.UTC(2026, 0, i + 1)),
  }));
}

describe('formatCollectionPage', () => {
  it('shows the project, edition, date and tier', () => {
    const text = formatCollectionPage(collectionPage(entries(1), 0));
    expect(text).toContain('Drop 0');
    expect(text).toContain('#1');
    expect(text).toContain('2026-01-01');
    expect(text).toContain('legendary');
  });

  it('does not label an ordinary claim with its tier', () => {
    const open = entries(2)[1] as CollectionEntry;
    const text = formatCollectionPage(collectionPage([open], 0));
    expect(text).not.toContain('legendary');
    expect(text).not.toContain('open');
  });

  it('says so plainly when there is nothing to show', () => {
    expect(formatCollectionPage(collectionPage([], 0))).toContain('not claimed anything yet');
  });

  it('omits the page footer when everything fits on one page', () => {
    const text = formatCollectionPage(collectionPage(entries(COLLECTION_PAGE_SIZE), 0));
    expect(text).not.toContain('Page 1 of');
  });

  it('numbers the pages when there is more than one', () => {
    const text = formatCollectionPage(collectionPage(entries(COLLECTION_PAGE_SIZE * 2 + 1), 0));
    expect(text).toContain('Page 1 of 3');
  });

  it('tells the member how to fetch each file', () => {
    const text = formatCollectionPage(collectionPage(entries(1), 0));
    expect(text).toContain('/mine drop-0');
  });
});

describe('collectionKeyboard', () => {
  it('attaches no keyboard when there is only one page', () => {
    expect(collectionKeyboard(collectionPage(entries(3), 0))).toBeUndefined();
  });

  it('offers only Next on the first page', () => {
    const keyboard = collectionKeyboard(collectionPage(entries(COLLECTION_PAGE_SIZE * 2), 0));
    const labels = keyboard?.inline_keyboard.flat().map((button) => button.text) ?? [];
    expect(labels).toEqual(['Next ›']);
  });

  it('offers only Previous on the last page', () => {
    const keyboard = collectionKeyboard(collectionPage(entries(COLLECTION_PAGE_SIZE * 2), 1));
    const labels = keyboard?.inline_keyboard.flat().map((button) => button.text) ?? [];
    expect(labels).toEqual(['‹ Previous']);
  });

  it('offers both in the middle', () => {
    const keyboard = collectionKeyboard(collectionPage(entries(COLLECTION_PAGE_SIZE * 3), 1));
    const labels = keyboard?.inline_keyboard.flat().map((button) => button.text) ?? [];
    expect(labels).toEqual(['‹ Previous', 'Next ›']);
  });
});

describe('parseCollectionPage', () => {
  it('reads a page index out of callback data', () => {
    expect(parseCollectionPage('g0')).toBe(0);
    expect(parseCollectionPage('g7')).toBe(7);
  });

  it('rejects anything that is not a page action', () => {
    for (const bad of ['r', 'c', 's1', 'g', 'g-1', 'gx', 'g999999999999', '']) {
      expect(parseCollectionPage(bad)).toBeNull();
    }
  });
});
