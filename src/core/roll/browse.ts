import { buildExclusionIndex, hasExcludedPair } from '../render/exclusions.js';
import { openTraits } from '../render/pack.js';
import type { TraitPack, TraitRecord } from '../render/types.js';

/**
 * Browsing one slot's options by name.
 *
 * Cycling is for a member with no particular destination. Browsing is for one
 * who knows exactly what they want, and the difference matters: a slot with
 * forty options is forty taps away by cycling and three by browsing. A product
 * that only cycles is a slot machine; the same product with a list is a tool.
 *
 * Pure, and page positions are all it deals in. Nothing here ever hands out a
 * trait id for a front end to send back — see pickOption for why.
 */

/**
 * Two columns of six. Enough that a forty-option slot is four pages, so any
 * option is reachable in three taps with a page row; few enough that a label
 * still fits beside another one on a narrow phone.
 */
export const BROWSE_PAGE_SIZE = 12;

export interface BrowseOption {
  readonly trait: TraitRecord;
  /** True for the option the member is currently holding in this slot. */
  readonly selected: boolean;
}

export interface BrowseView {
  readonly slotIndex: number;
  readonly slotName: string;
  readonly options: readonly BrowseOption[];
  readonly pageIndex: number;
  readonly pageCount: number;
  /** Total options across every page, after exclusions are removed. */
  readonly total: number;
  /**
   * Options left out because they clash with another slot. Reported rather
   * than silently dropped: a member who counted forty hats and sees
   * thirty-seven is owed the reason, and an untappable button is a dead end.
   */
  readonly hiddenByExclusion: number;
}

export function browsePageCount(total: number): number {
  // One page, reading as empty, rather than zero pages to special-case.
  return Math.max(1, Math.ceil(total / BROWSE_PAGE_SIZE));
}

/**
 * Every option in a slot that can actually be chosen right now.
 *
 * Filtered rather than marked, because a button that cannot be pressed is a
 * dead end and this product does not have those. The count of what was removed
 * is carried out so the caption can say so.
 *
 * Deterministic given the same pack and combination, which is what lets a page
 * position be resolved back to an option without the position ever having to
 * travel as a trait id.
 */
function choosableOptions(
  pack: TraitPack,
  current: readonly TraitRecord[],
  slotIndex: number,
): { readonly options: readonly TraitRecord[]; readonly hidden: number } | null {
  const slot = pack.slots[slotIndex];
  if (slot === undefined || current.length !== pack.slots.length) {
    return null;
  }

  const exclusions = buildExclusionIndex(pack.exclusions);
  const held = current[slotIndex];
  const candidates = openTraits(slot);

  const options = candidates.filter((option) => {
    // What they are already holding always stays listed, so the page can show
    // where they are even if the pack has since grown a clash around it.
    if (option.id === held?.id) {
      return true;
    }
    const proposed = current.map((trait, index) => (index === slotIndex ? option : trait));
    return !hasExcludedPair(
      exclusions,
      proposed.map((trait) => trait.id),
    );
  });

  return { options, hidden: candidates.length - options.length };
}

/** Clamps rather than rejects: a stale page button should show the last page. */
export function clampBrowsePage(requested: number, pageCount: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0) {
    return 0;
  }
  return Math.min(requested, pageCount - 1);
}

/** One page of a slot's options, or null if the slot no longer resolves. */
export function browseSlot(
  pack: TraitPack,
  current: readonly TraitRecord[],
  slotIndex: number,
  requestedPage: number,
): BrowseView | null {
  const choosable = choosableOptions(pack, current, slotIndex);
  const slot = pack.slots[slotIndex];
  if (choosable === null || slot === undefined) {
    return null;
  }

  const pageCount = browsePageCount(choosable.options.length);
  const pageIndex = clampBrowsePage(requestedPage, pageCount);
  const start = pageIndex * BROWSE_PAGE_SIZE;
  const held = current[slotIndex];

  return {
    slotIndex,
    slotName: slot.slot,
    options: choosable.options
      .slice(start, start + BROWSE_PAGE_SIZE)
      .map((trait) => ({ trait, selected: trait.id === held?.id })),
    pageIndex,
    pageCount,
    total: choosable.options.length,
    hiddenByExclusion: choosable.hidden,
  };
}

/**
 * Resolves a position on the page a member is looking at into a combination.
 *
 * The position is the only thing a front end sends back, and it addresses
 * nothing outside the page the server last rendered. That is deliberate: a
 * trait id in a callback payload is an attacker-supplied trait id, and this
 * way there is no id to tamper with — the worst a forged position can do is
 * select a different option in the slot the member had already opened.
 *
 * Returns null if the position is off the page, which callers treat as
 * "ignore" rather than defaulting to anything.
 */
export function pickOption(
  pack: TraitPack,
  current: readonly TraitRecord[],
  slotIndex: number,
  pageIndex: number,
  positionOnPage: number,
): readonly TraitRecord[] | null {
  const view = browseSlot(pack, current, slotIndex, pageIndex);
  if (view === null || view.pageIndex !== pageIndex) {
    return null;
  }

  const chosen = view.options[positionOnPage];
  if (chosen === undefined) {
    return null;
  }

  return current.map((trait, index) => (index === slotIndex ? chosen.trait : trait));
}
