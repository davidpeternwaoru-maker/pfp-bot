/**
 * Renders one random open-pool combination from a folder of PNGs, with no
 * database and no Telegram involved.
 *
 * Layout: one directory per slot, named "<layerOrder>-<slot>", each holding the
 * options for that slot as full-canvas PNGs.
 *
 *   npm run render:sample -- demo-traits output/sample.png
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { combinationHash, contentHash } from '../src/core/render/hash.js';
import { buildTraitPack, openPoolCapacity } from '../src/core/render/pack.js';
import { renderCombination } from '../src/core/render/image.js';
import { selectOpenCombination } from '../src/core/render/select.js';
import type { TraitRecord } from '../src/core/render/types.js';

const SLOT_DIR = /^(\d+)-(.+)$/;

async function collectTraits(root: string): Promise<TraitRecord[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const traits: TraitRecord[] = [];
  let nextId = 1;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const match = SLOT_DIR.exec(entry.name);
    if (match === null) {
      throw new Error(`directory "${entry.name}" is not named "<layerOrder>-<slot>"`);
    }
    const layerOrder = Number(match[1]);
    const slot = match[2] ?? entry.name;

    const files = (await readdir(join(root, entry.name))).filter((f) => f.endsWith('.png')).sort();
    for (const file of files) {
      traits.push({
        id: nextId++,
        slot,
        name: file.replace(/\.png$/, ''),
        layerOrder,
        imagePath: `${entry.name}/${file}`,
        rarityWeight: 1,
        tier: 'open',
      });
    }
  }

  return traits;
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? 'demo-traits');
  const outPath = resolve(process.argv[3] ?? join('output', 'sample.png'));

  const traits = await collectTraits(root);
  if (traits.length === 0) {
    throw new Error(`no trait PNGs found under ${root}`);
  }

  // Canvas size is taken from the first image; every other image must match it,
  // which is exactly what loadTraitImage enforces during the render.
  const first = traits[0];
  if (first === undefined) {
    throw new Error('no traits collected');
  }
  const probe = await sharp(join(root, first.imagePath)).metadata();
  const canvas = { width: probe.width ?? 0, height: probe.height ?? 0 };

  const pack = buildTraitPack({ projectId: 0, canvas, traits, exclusions: [] });
  const combination = selectOpenCombination(pack);
  const png = await renderCombination(combination, { canvas, root });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, png);

  const lines = [
    `canvas          ${String(canvas.width)}x${String(canvas.height)}`,
    `slots           ${pack.slots.map((s) => s.slot).join(' -> ')}`,
    `open capacity   ${String(openPoolCapacity(pack))} combinations`,
    '',
    ...combination.map((t) => `  ${t.slot.padEnd(14)} ${t.name}`),
    '',
    `combinationHash ${combinationHash(combination.map((t) => t.id))}`,
    `contentHash     ${contentHash(png)}`,
    `written         ${outPath}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

await main();
