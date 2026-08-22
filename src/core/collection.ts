import type { CollectionEntry } from './db/claim-repository.js';

/**
 * The cross-project collection, as data.
 *
 * Paging is worked out here; wording and buttons are not. A page is a slice of
 * entries plus where it sits — how that reads on a phone, in a browser, or in
 * a Discord embed is the front end's decision.
 */

/** Chosen to fit one Telegram message; front ends may page differently later. */
export const COLLECTION_PAGE_SIZE = 8;

export interface CollectionPageView {
  readonly entries: readonly CollectionEntry[];
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly total: number;
}

export function pageCountFor(total: number): number {
  // One page, reading "nothing yet", rather than zero pages to special-case.
  return Math.max(1, Math.ceil(total / COLLECTION_PAGE_SIZE));
}

/** Clamps rather than rejects: a stale page button should show the last page. */
export function clampPage(requested: number, pageCount: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0) {
    return 0;
  }
  return Math.min(requested, pageCount - 1);
}

export function collectionPage(
  entries: readonly CollectionEntry[],
  requestedPage: number,
): CollectionPageView {
  const pageCount = pageCountFor(entries.length);
  const pageIndex = clampPage(requestedPage, pageCount);
  const start = pageIndex * COLLECTION_PAGE_SIZE;

  return {
    entries: entries.slice(start, start + COLLECTION_PAGE_SIZE),
    pageIndex,
    pageCount,
    total: entries.length,
  };
}
