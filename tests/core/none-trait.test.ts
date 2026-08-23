import { rm } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { combinationHash, contentHash } from '../../src/core/render/hash.js';
import { renderCombination, transparentCanvas } from '../../src/core/render/image.js';
import { ensureNoneImage, NONE_TRAIT_NAME, noneImagePath } from '../../src/core/render/none.js';
import { buildTraitPack, openPoolCapacity, openTraits } from '../../src/core/render/pack.js';
import { selectOpenCombination } from '../../src/core/render/select.js';
import { drawUnclaimed } from '../../src/core/roll/pool.js';
import type { TraitRecord } from '../../src/core/render/types.js';
import {
  makeTempRoot,
  pixelAt,
  seededRandom,
  solidPng,
  writeFixture,
} from '../helpers/fixtures.js';

/**
 * "No hat" is not a special case, and this is the test that says so.
 *
 * The whole design of the none option is that nothing branches on it: it is an
 * ordinary trait row pointing at a transparent layer. The way to prove that is
 * to build the most extreme combination it makes possible — every slot set to
 * none — and put it through the render, the hash, the capacity count, the
 * selector and the sweep without any of them being told it is unusual.
 */

const CANVAS = { width: 16, height: 16 } as const;

let root: string;

afterAll(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
  }
});

/** Two slots, each offering one drawn option and the none option. */
async function buildPack(): Promise<{
  pack: ReturnType<typeof buildTraitPack>;
  allNone: readonly TraitRecord[];
}> {
  root = await makeTempRoot();

  const nonePath = await ensureNoneImage(root, CANVAS);
  const bodyPath = await writeFixture(
    root,
    'body.png',
    await solidPng(CANVAS.width, CANVAS.height, { r: 10, g: 20, b: 30, a: 255 }),
  );
  const hatPath = await writeFixture(
    root,
    'hat.png',
    await solidPng(CANVAS.width, CANVAS.height, { r: 200, g: 100, b: 50, a: 255 }),
  );

  const traits: TraitRecord[] = [
    {
      id: 1,
      slot: 'body',
      name: 'plain',
      layerOrder: 10,
      imagePath: bodyPath,
      rarityWeight: 1,
      tier: 'open',
    },
    {
      id: 2,
      slot: 'body',
      name: NONE_TRAIT_NAME,
      layerOrder: 10,
      imagePath: nonePath,
      rarityWeight: 1,
      tier: 'open',
    },
    {
      id: 3,
      slot: 'hat',
      name: 'cap',
      layerOrder: 20,
      imagePath: hatPath,
      rarityWeight: 1,
      tier: 'open',
    },
    {
      id: 4,
      slot: 'hat',
      name: NONE_TRAIT_NAME,
      layerOrder: 20,
      imagePath: nonePath,
      rarityWeight: 1,
      tier: 'open',
    },
  ];

  const pack = buildTraitPack({ projectId: 1, canvas: CANVAS, traits, exclusions: [] });
  const allNone = traits.filter((trait) => trait.name === NONE_TRAIT_NAME);

  return { pack, allNone };
}

describe('the none option', () => {
  it('renders, hashes, and is an ordinary unique combination when every slot is none', async () => {
    const { pack, allNone } = await buildPack();

    // Renders. Nothing refuses a combination made entirely of empty layers.
    const image = await renderCombination(allNone, { canvas: CANVAS, root });
    expect(image.length).toBeGreaterThan(0);

    // And renders to what it should: a canvas that is still fully transparent.
    for (const [x, y] of [
      [0, 0],
      [8, 8],
      [15, 15],
    ] as const) {
      expect((await pixelAt(image, x, y)).a).toBe(0);
    }

    // Hashes. The hasher sees two ordinary trait ids and never learns what
    // they point at, which is exactly why this needs no case of its own.
    const ids = allNone.map((trait) => trait.id);
    const hash = combinationHash(ids);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(combinationHash([...ids].reverse()));

    // And it is a distinct combination, not a collision with any other.
    const everyCombination = new Set<string>();
    for (const body of pack.slots[0]?.traits ?? []) {
      for (const hat of pack.slots[1]?.traits ?? []) {
        everyCombination.add(combinationHash([body.id, hat.id]));
      }
    }
    expect(everyCombination.size).toBe(4);
    expect(everyCombination.has(hash)).toBe(true);
  });

  it('is counted by the capacity calculator as a valid option', async () => {
    const { pack } = await buildPack();

    // Two options per slot, one of which is none. A capacity count that
    // skipped it would report 1 and understate the drop by three quarters.
    expect(openTraits(pack.slots[0] as never).length).toBe(2);
    expect(openPoolCapacity(pack)).toBe(4);
  });

  it('is reachable by rolling, like any other open option', async () => {
    const { pack } = await buildPack();

    const seen = new Set<string>();
    const random = seededRandom(7);
    for (let i = 0; i < 200; i += 1) {
      for (const trait of selectOpenCombination(pack, random)) {
        seen.add(trait.name);
      }
    }

    // The selector filters on tier and nothing else, so none is drawn as
    // readily as anything else in the slot.
    expect(seen.has(NONE_TRAIT_NAME)).toBe(true);
    expect(seen.has('plain')).toBe(true);
  });

  it('lets the sweep reach the all-none combination when it is the last one left', async () => {
    const { pack, allNone } = await buildPack();
    const allNoneHash = combinationHash(allNone.map((trait) => trait.id));

    const taken = new Set<string>();
    for (const body of pack.slots[0]?.traits ?? []) {
      for (const hat of pack.slots[1]?.traits ?? []) {
        const hash = combinationHash([body.id, hat.id]);
        if (hash !== allNoneHash) {
          taken.add(hash);
        }
      }
    }

    const outcome = drawUnclaimed({
      pack,
      isClaimed: (hash) => taken.has(hash),
      random: seededRandom(3),
    });

    // The pool is not exhausted while "no hat and no body" is still free.
    expect(outcome.kind).toBe('drawn');
    if (outcome.kind === 'drawn') {
      expect(outcome.hash).toBe(allNoneHash);
    }
  });

  it('writes one transparent file per canvas size, with stable bytes', async () => {
    root = await makeTempRoot();

    const first = await ensureNoneImage(root, CANVAS);
    const second = await ensureNoneImage(root, CANVAS);

    // Shared by every slot: N identical copies would be N chances to drift.
    expect(first).toBe(second);
    expect(first).toBe(noneImagePath(CANVAS));

    // The claim's contentHash is derived from rendered bytes, so a none layer
    // that re-encoded differently would make a claim unreproducible.
    expect(contentHash(await transparentCanvas(CANVAS))).toBe(
      contentHash(await transparentCanvas(CANVAS)),
    );
  });
});
