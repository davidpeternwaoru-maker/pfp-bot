import { InlineKeyboard } from 'grammy';
import type { CollectionEntry } from '../../core/db/claim-repository.js';
import type { CollectionPageView } from '../../core/collection.js';
import { collectionPageAction } from './callback-data.js';

/** How a collection page reads in Telegram. Paging itself lives in core. */

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
  // The /mine hint is why this formatting is Telegram's and not core's.
  return `#${String(entry.editionNumber)} · ${entry.projectName}${tierLabel(entry.tier)}\n    ${date} · /mine ${entry.projectSlug}`;
}

export function formatCollectionPage(page: CollectionPageView): string {
  if (page.total === 0) {
    return 'You have not claimed anything yet. Open a collection link to roll one.';
  }

  const header = page.total === 1 ? 'You hold 1 claim.' : `You hold ${String(page.total)} claims.`;
  const footer =
    page.pageCount > 1 ? `\n\nPage ${String(page.pageIndex + 1)} of ${String(page.pageCount)}` : '';

  return `${header}\n\n${page.entries.map(formatEntry).join('\n\n')}${footer}`;
}

/** Undefined when everything fits on one page, so no keyboard is attached. */
export function collectionKeyboard(page: CollectionPageView): InlineKeyboard | undefined {
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
