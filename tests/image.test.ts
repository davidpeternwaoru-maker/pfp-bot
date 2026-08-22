import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { TraitImageError } from '../src/render/errors.js';
import { loadTraitImage, renderCombination } from '../src/render/image.js';
import { contentHash } from '../src/render/hash.js';
import { leftHalfPng, makeTempRoot, pixelAt, solidPng, trait } from './helpers/fixtures.js';

/**
 * Windows without developer mode refuses symlink creation. Probed at collection
 * time so the symlink test reports as skipped rather than quietly passing
 * without exercising anything.
 */
const symlinksSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'pfp-bot-symprobe-'));
  try {
    writeFileSync(join(probe, 'a'), 'x');
    symlinkSync(join(probe, 'a'), join(probe, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const canvas = { width: 64, height: 64 } as const;
const RED = { r: 255, g: 0, b: 0, a: 255 } as const;
const BLUE = { r: 0, g: 0, b: 255, a: 255 } as const;

let root: string;

beforeAll(async () => {
  root = await makeTempRoot();
  await writeFile(join(root, 'background.png'), await solidPng(64, 64, RED));
  await writeFile(join(root, 'overlay.png'), await leftHalfPng(64, 64, BLUE));
  await writeFile(join(root, 'wrong-size.png'), await solidPng(32, 64, RED));
  // A JPEG deliberately named .png — the extension is a claim, not evidence.
  await writeFile(
    join(root, 'liar.png'),
    await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer(),
  );
  await writeFile(join(root, 'truncated.png'), Uint8Array.from([0x89, 0x50, 0x4e]));
  await writeFile(join(root, 'huge.png'), await solidPng(64, 64, RED));

  await mkdir(join(root, 'nested'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadTraitImage', () => {
  it('accepts a correctly sized PNG', async () => {
    const bytes = await loadTraitImage('background.png', { canvas, root });
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('rejects an image whose dimensions do not match the canvas', async () => {
    await expect(loadTraitImage('wrong-size.png', { canvas, root })).rejects.toThrow(
      /32x64, expected 64x64/,
    );
  });

  it('rejects a JPEG wearing a .png extension', async () => {
    await expect(loadTraitImage('liar.png', { canvas, root })).rejects.toThrow(/not a PNG/);
  });

  it('rejects a truncated file', async () => {
    await expect(loadTraitImage('truncated.png', { canvas, root })).rejects.toThrow(/not a PNG/);
  });

  it('rejects a file over the size limit before reading it', async () => {
    await expect(loadTraitImage('huge.png', { canvas, root, maxBytes: 10 })).rejects.toThrow(
      /over the 10 byte limit/,
    );
  });

  it('names the offending file in every failure', async () => {
    const error = await loadTraitImage('wrong-size.png', { canvas, root }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TraitImageError);
    expect((error as TraitImageError).imagePath).toBe('wrong-size.png');
    expect((error as TraitImageError).message).toContain('wrong-size.png');
  });

  it('refuses a path that escapes the pack root', async () => {
    await expect(loadTraitImage('../escape.png', { canvas, root })).rejects.toThrow(/outside/);
  });

  it.skipIf(!symlinksSupported)('refuses a symlink pointing outside the pack root', async () => {
    const outside = await makeTempRoot();
    await writeFile(join(outside, 'secret.png'), await solidPng(64, 64, RED));
    await symlink(join(outside, 'secret.png'), join(root, 'nested', 'link.png'));

    await expect(loadTraitImage('nested/link.png', { canvas, root })).rejects.toThrow(/outside/);
    await rm(outside, { recursive: true, force: true });
  });

  it('reports a missing file clearly', async () => {
    await expect(loadTraitImage('nope.png', { canvas, root })).rejects.toThrow(/does not exist/);
  });
});

describe('renderCombination', () => {
  const background = trait({
    id: 1,
    slot: 'background',
    layerOrder: 0,
    imagePath: 'background.png',
  });
  const overlay = trait({ id: 2, slot: 'overlay', layerOrder: 10, imagePath: 'overlay.png' });

  it('stacks later layers on top of earlier ones', async () => {
    const png = await renderCombination([background, overlay], { canvas, root });

    // Left half is covered by the overlay; right half shows the background.
    expect(await pixelAt(png, 10, 32)).toEqual(BLUE);
    expect(await pixelAt(png, 54, 32)).toEqual(RED);
  });

  it('ignores the order the traits were passed in, using layerOrder instead', async () => {
    const forwards = await renderCombination([background, overlay], { canvas, root });
    const backwards = await renderCombination([overlay, background], { canvas, root });

    // Identical bytes: the stored contentHash must not depend on argument order.
    expect(contentHash(backwards)).toBe(contentHash(forwards));
  });

  it('produces the same bytes on every render of the same combination', async () => {
    const first = await renderCombination([background, overlay], { canvas, root });
    const second = await renderCombination([background, overlay], { canvas, root });
    expect(contentHash(second)).toBe(contentHash(first));
  });

  it('fails the whole render if any single layer is invalid', async () => {
    const broken = trait({ id: 3, slot: 'broken', layerOrder: 5, imagePath: 'liar.png' });
    await expect(renderCombination([background, broken], { canvas, root })).rejects.toThrow(
      TraitImageError,
    );
  });
});
