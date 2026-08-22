import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { TraitRecord, TraitTier } from '../../src/render/types.js';

/** Deterministic PRNG (mulberry32) so distribution tests can never flake. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pfp-bot-fixtures-'));
}

/** A PNG filled with one colour, edge to edge. */
export async function solidPng(width: number, height: number, colour: Rgba): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: colour.r, g: colour.g, b: colour.b, alpha: colour.a / 255 },
    },
  })
    .png()
    .toBuffer();
}

/** A PNG whose left half is `colour` and whose right half is transparent. */
export async function leftHalfPng(width: number, height: number, colour: Rgba): Promise<Buffer> {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width * 0.5; x += 1) {
      const i = (y * width + x) * 4;
      pixels[i] = colour.r;
      pixels[i + 1] = colour.g;
      pixels[i + 2] = colour.b;
      pixels[i + 3] = colour.a;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/** Reads one pixel out of a rendered PNG. */
export async function pixelAt(png: Buffer, x: number, y: number): Promise<Rgba> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return {
    r: data[i] ?? 0,
    g: data[i + 1] ?? 0,
    b: data[i + 2] ?? 0,
    a: data[i + 3] ?? 0,
  };
}

export async function writeFixture(root: string, name: string, bytes: Uint8Array): Promise<string> {
  await writeFile(join(root, name), bytes);
  return name;
}

let nextTraitId = 1;

export function trait(overrides: Partial<TraitRecord> & { slot: string }): TraitRecord {
  const id = overrides.id ?? nextTraitId++;
  const tier: TraitTier = overrides.tier ?? 'open';
  return {
    id,
    slot: overrides.slot,
    name: overrides.name ?? `trait-${String(id)}`,
    layerOrder: overrides.layerOrder ?? 0,
    imagePath: overrides.imagePath ?? `${overrides.slot}-${String(id)}.png`,
    rarityWeight: overrides.rarityWeight ?? 1,
    tier,
  };
}
