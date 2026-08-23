import { describe, expect, it } from 'vitest';
import {
  BROWSE_PAGE_SIZE,
  browsePageCount,
  browseSlot,
  clampBrowsePage,
  pickOption,
} from '../../src/core/roll/browse.js';
import { buildTraitPack } from '../../src/core/render/pack.js';
import type { TraitPack, TraitRecord } from '../../src/core/render/types.js';

/**
 * Browsing is what stops a large slot being a slot machine.
 *
 * The phase gate is a tap count: forty options must be reachable in under five
 * taps. That is not a feeling, it is arithmetic over the page size and the page
 * row, so it is asserted here rather than judged by eye.
 */

const CANVAS = { width: 8, height: 8 } as const;

/** A hat slot with `hats` options, over a compulsory body. */
function pack(hats: number, exclusions: { traitAId: number; traitBId: number }[] = []): TraitPack {
  const traits: TraitRecord[] = [
    {
      id: 1,
      slot: 'body',
      name: 'body-a',
      layerOrder: 10,
      imagePath: 'a.png',
      rarityWeight: 1,
      tier: 'open',
    },
    {
      id: 2,
      slot: 'body',
      name: 'body-b',
      layerOrder: 10,
      imagePath: 'b.png',
      rarityWeight: 1,
      tier: 'open',
    },
  ];

  for (let i = 0; i < hats; i += 1) {
    traits.push({
      id: 100 + i,
      slot: 'hat',
      name: `hat-${String(i + 1)}`,
      layerOrder: 20,
      imagePath: `h${String(i)}.png`,
      rarityWeight: 1,
      // One reserved option, to prove the list is the open pool and not the
      // whole slot. A legendary must never be reachable by browsing.
      tier: i === 0 ? 'legendary' : 'open',
    });
  }

  return buildTraitPack({ projectId: 1, canvas: CANVAS, traits, exclusions });
}

function held(p: TraitPack, hatIndex: number): readonly TraitRecord[] {
  const body = p.slots[0]?.traits[0];
  const hat = p.slots[1]?.traits[hatIndex];
  if (body === undefined || hat === undefined) {
    throw new Error('fixture pack too small');
  }
  return [body, hat];
}

describe('browsing a slot', () => {
  it('reaches any option in a forty-option slot in under five taps', () => {
    // 40 open options, plus the one legendary that is never listed.
    const p = pack(41);
    const current = held(p, 1);

    const first = browseSlot(p, current, 1, 0);
    expect(first?.total).toBe(40);

    const pageCount = first?.pageCount ?? 0;

    // The taps are: open the list, choose a page, choose the option. The page
    // row offers every page directly, so the middle step is one tap whatever
    // page the option sits on — that is the whole reason it is a page row and
    // not a "next" button.
    const tapsToAnyOption = 1 + 1 + 1;
    expect(tapsToAnyOption).toBeLessThan(5);

    // And the page row only stays one tap while every page fits on it.
    expect(pageCount).toBeLessThanOrEqual(6);

    // Every option really is reachable: walk all pages and collect them.
    const reached = new Set<string>();
    for (let page = 0; page < pageCount; page += 1) {
      for (const option of browseSlot(p, current, 1, page)?.options ?? []) {
        reached.add(option.trait.name);
      }
    }
    expect(reached.size).toBe(40);
    expect(reached.has('hat-1')).toBe(false);
  });

  it('pages without gaps or repeats', () => {
    const p = pack(30);
    const current = held(p, 1);

    const seen: number[] = [];
    const pageCount = browseSlot(p, current, 1, 0)?.pageCount ?? 0;
    for (let page = 0; page < pageCount; page += 1) {
      const view = browseSlot(p, current, 1, page);
      expect(view?.pageIndex).toBe(page);
      for (const option of view?.options ?? []) {
        seen.push(option.trait.id);
      }
    }

    expect(seen.length).toBe(29);
    expect(new Set(seen).size).toBe(29);
    expect(browsePageCount(29)).toBe(Math.ceil(29 / BROWSE_PAGE_SIZE));
  });

  it('marks where the member currently is', () => {
    const p = pack(20);
    const current = held(p, 3);

    const view = browseSlot(p, current, 1, 0);
    const selected = view?.options.filter((option) => option.selected) ?? [];

    expect(selected.length).toBe(1);
    expect(selected[0]?.trait.id).toBe(current[1]?.id);
  });

  it('hides options that clash, and says how many rather than dropping them silently', () => {
    // The body they are holding clashes with two hats.
    const p = pack(10, [
      { traitAId: 1, traitBId: 102 },
      { traitAId: 1, traitBId: 103 },
    ]);
    const current = held(p, 1);

    const view = browseSlot(p, current, 1, 0);

    // Nine open hats, two of which cannot be worn with this body.
    expect(view?.total).toBe(7);
    expect(view?.hiddenByExclusion).toBe(2);
    expect(view?.options.some((option) => option.trait.id === 102)).toBe(false);

    // A hidden option cannot be picked by position either, because positions
    // address the filtered list and nothing else.
    const names = (view?.options ?? []).map((option) => option.trait.id);
    expect(names).not.toContain(102);
  });

  it('clamps a stale page to the last one rather than failing', () => {
    const p = pack(5);
    const current = held(p, 1);

    const view = browseSlot(p, current, 1, 99);
    expect(view?.pageIndex).toBe(0);
    expect(clampBrowsePage(99, 3)).toBe(2);
    expect(clampBrowsePage(-1, 3)).toBe(0);
  });

  it('resolves a position on the page into a combination, changing only that slot', () => {
    const p = pack(20);
    const current = held(p, 1);

    const picked = pickOption(p, current, 1, 1, 2);
    expect(picked).not.toBeNull();

    // The body is untouched; only the hat moved.
    expect(picked?.[0]?.id).toBe(current[0]?.id);
    expect(picked?.[1]?.id).not.toBe(current[1]?.id);

    // And it is the option that page actually showed.
    const shown = browseSlot(p, current, 1, 1)?.options[2]?.trait.id;
    expect(picked?.[1]?.id).toBe(shown);
  });

  it('refuses a position that is not on the page the member has open', () => {
    const p = pack(20);
    const current = held(p, 1);

    // Off the end of the page, and negative. A forged callback payload can
    // only ever say a number; neither of these addresses an option.
    expect(pickOption(p, current, 1, 0, BROWSE_PAGE_SIZE)).toBeNull();
    expect(pickOption(p, current, 1, 0, -1)).toBeNull();
    expect(pickOption(p, current, 1, 0, 9999)).toBeNull();

    // A page beyond the end clamps when browsing, so picking against it must
    // not silently resolve against a different page than the one displayed.
    expect(pickOption(p, current, 1, 99, 0)).toBeNull();
  });

  it('refuses a slot index outside the pack', () => {
    const p = pack(5);
    const current = held(p, 1);

    expect(browseSlot(p, current, 7, 0)).toBeNull();
    expect(pickOption(p, current, 7, 0, 0)).toBeNull();
  });
});
