/**
 * Writes a small folder of generated PNGs so the render engine can be run
 * before any real artwork exists. Layout mirrors what the Phase 7 importer
 * will expect: one directory per slot, named "<layerOrder>-<slot>".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const SIZE = 512;

const SLOTS = [
  { dir: '00-background', colours: ['#1b1f3b', '#3b1b2f', '#123524'] },
  { dir: '10-body', colours: ['#e8c39e', '#b5764a', '#6d4630'] },
  { dir: '20-eyes', colours: ['#ffffff', '#8ef6e4', '#f6d68e'] },
  { dir: '30-hat', colours: ['#c0392b', '#2980b9'] },
] as const;

async function backgroundLayer(colour: string): Promise<Buffer> {
  return sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: colour } })
    .png()
    .toBuffer();
}

/** A centred shape on a transparent canvas, so upper layers really do overlay. */
async function shapeLayer(colour: string, svgBody: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${svgBody.replaceAll('COLOUR', colour)}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const SHAPES: Record<string, string> = {
  '10-body': '<circle cx="256" cy="300" r="150" fill="COLOUR"/>',
  '20-eyes':
    '<circle cx="210" cy="270" r="26" fill="COLOUR"/><circle cx="302" cy="270" r="26" fill="COLOUR"/>',
  '30-hat': '<rect x="150" y="120" width="212" height="60" rx="12" fill="COLOUR"/>',
};

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? 'demo-traits');
  await mkdir(root, { recursive: true });

  for (const slot of SLOTS) {
    const dir = join(root, slot.dir);
    await mkdir(dir, { recursive: true });

    for (const [index, colour] of slot.colours.entries()) {
      const shape = SHAPES[slot.dir];
      const png =
        shape === undefined ? await backgroundLayer(colour) : await shapeLayer(colour, shape);
      await writeFile(join(dir, `option-${String(index + 1)}.png`), png);
    }
  }

  process.stdout.write(`demo traits written to ${root} (${String(SIZE)}x${String(SIZE)})\n`);
}

await main();
