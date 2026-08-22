import { InlineKeyboard } from 'grammy';
import type { CollectionEntry } from '../db/claim-repository.js';
import { collectionPageAction } from './callback-data.js';

/**
 * The cross-project collection view.
 *
 * Pure: paging and formatting are worked out here so both can be tested
 * without a bot, a database, or a chat.
 */

/** Fits comfortably in one Telegram message on a phone. */
export const COLLECTION_PAGE_SIZE = 8;

export interface CollectionPage {
  readonly text: string;
  readonly pageIndex: number;
  readonly pageCount: number;
}

function tierLabel(tier: CollectionEntry['tier']): string {
  switch (tier) {
    case 'legendary':
      return ' ★ legendary';
    case 'gated':
      return ' ◆ gated';
    case 'open':
      return '';
  }
}

function formatEntry(entry: CollectionEntry): string {
  const date = entry.claimedAt.toISOString().slice(0, 10);
  return `#${String(entry.editionNumber)} · ${entry.projectName}${tierLabel(entry.tier)}\n    ${date} · /mine ${entry.projectSlug}`;
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

export function renderCollectionPage(
  entries: readonly CollectionEntry[],
  requestedPage: number,
): CollectionPage {
  const pageCount = pageCountFor(entries.length);
  const pageIndex = clampPage(requestedPage, pageCount);

  if (entries.length === 0) {
    return {
      text: 'You have not claimed anything yet. Open a collection link to roll one.',
      pageIndex: 0,
      pageCount: 1,
    };
  }

  const start = pageIndex * COLLECTION_PAGE_SIZE;
  const slice = entries.slice(start, start + COLLECTION_PAGE_SIZE);

  const header =
    entries.length === 1 ? 'You hold 1 claim.' : `You hold ${String(entries.length)} claims.`;

  const footer = pageCount > 1 ? `\n\nPage ${String(pageIndex + 1)} of ${String(pageCount)}` : '';

  return {
    text: `${header}\n\n${slice.map(formatEntry).join('\n\n')}${footer}`,
    pageIndex,
    pageCount,
  };
}

/** Undefined when everything fits on one page, so no keyboard is attached. */
export function collectionKeyboard(page: CollectionPage): InlineKeyboard | undefined {
  if (page.pageCount <= 1) {
    return undefined;
  }

  const keyboard = new InlineKeyboard();
  if (page.pageIndex > 0) {
    keyboard.text('‹ Previous', collectionPageAction(page.pageIndex - 1));
  }
  if (page.pageIndex < page.pageCount - 1) {
    keyboard.text('Next ›', collectionPageAction(page.pageIndex + 1));
  }
  return keyboard;
}
