import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { resolveWithinRoot } from '../fs/within-root.js';
import { TraitImageError } from './errors.js';
import type { CanvasSize, TraitRecord } from './types.js';

/** The eight bytes every PNG starts with. */
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A full-canvas PNG layer well past this size is a mistake or an attack. */
export const MAX_TRAIT_IMAGE_BYTES = 2 * 1024 * 1024;

export interface TraitImageOptions {
  readonly canvas: CanvasSize;
  /** Every trait image must resolve inside this directory. */
  readonly root: string;
  readonly maxBytes?: number;
}

/**
 * Confines a stored path to the pack root, translating the shared containment
 * result into the error type this module reports. Stored paths are
 * admin-supplied rather than member-supplied, but a bad trait import must not
 * become an arbitrary file read.
 */
async function locateTraitImage(root: string, imagePath: string): Promise<string> {
  const located = await resolveWithinRoot(root, imagePath);
  if (located.ok) {
    return located.path;
  }

  const reason =
    located.reason === 'missing'
      ? 'file does not exist'
      : located.reason === 'links-outside'
        ? 'links outside the trait pack root'
        : 'resolves outside the trait pack root';

  throw new TraitImageError(imagePath, reason);
}

/**
 * Reads one trait layer, rejecting anything that would corrupt a render:
 * wrong size, not actually a PNG, or too large.
 */
export async function loadTraitImage(
  imagePath: string,
  options: TraitImageOptions,
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_TRAIT_IMAGE_BYTES;
  const absolute = await locateTraitImage(options.root, imagePath);

  const info = await stat(absolute);
  if (!info.isFile()) {
    throw new TraitImageError(imagePath, 'is not a regular file');
  }
  // Size is checked before reading so an oversized file never enters memory.
  if (info.size > maxBytes) {
    throw new TraitImageError(
      imagePath,
      `is ${String(info.size)} bytes, over the ${String(maxBytes)} byte limit`,
    );
  }

  const bytes = await readFile(absolute);

  // The extension is a claim, not evidence — check the actual header.
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new TraitImageError(imagePath, 'is not a PNG (header bytes do not match)');
  }

  const metadata = await sharp(bytes)
    .metadata()
    .catch(() => {
      throw new TraitImageError(imagePath, 'could not be decoded as an image');
    });

  if (metadata.format !== 'png') {
    throw new TraitImageError(imagePath, `decodes as ${metadata.format ?? 'unknown'}, not png`);
  }

  const { width, height } = options.canvas;
  if (metadata.width !== width || metadata.height !== height) {
    throw new TraitImageError(
      imagePath,
      `is ${String(metadata.width)}x${String(metadata.height)}, expected ${String(width)}x${String(height)}`,
    );
  }

  return bytes;
}

/**
 * Stacks pre-aligned, full-canvas layers onto a transparent canvas.
 * Every layer is already the canvas size, so this is pure stacking — no
 * offsets, no resizing, no positioning maths.
 */
export async function compositeLayers(
  layers: readonly Buffer[],
  canvas: CanvasSize,
): Promise<Buffer> {
  if (layers.length === 0) {
    throw new RangeError('compositeLayers requires at least one layer');
  }

  return (
    sharp({
      create: {
        width: canvas.width,
        height: canvas.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(layers.map((input) => ({ input })))
      // Fixed encoder settings: the rendered bytes are hashed into the claim, so
      // the same combination must produce the same file every time.
      .png({ compressionLevel: 9, effort: 7 })
      .toBuffer()
  );
}

/**
 * A fully transparent canvas-sized PNG.
 *
 * This is the artwork behind every slot's "none" option, and the reason "none"
 * needs no special case anywhere: compositing a transparent layer already
 * produces exactly what a "skip this slot" branch would have to fake, in every
 * consumer, forever.
 *
 * Same encoder settings as a render, so the file passes the identical
 * validation a hand-made trait does and its bytes never drift.
 */
export async function transparentCanvas(canvas: CanvasSize): Promise<Buffer> {
  return sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png({ compressionLevel: 9, effort: 7 })
    .toBuffer();
}

/**
 * Renders a combination to a PNG buffer.
 * Sorts by layerOrder rather than trusting the caller's ordering, because the
 * result is hashed and stored — a reordered input must not change the output.
 */
export async function renderCombination(
  traits: readonly TraitRecord[],
  options: TraitImageOptions,
): Promise<Buffer> {
  const ordered = [...traits].sort((a, b) => a.layerOrder - b.layerOrder);
  const layers = await Promise.all(
    ordered.map((trait) => loadTraitImage(trait.imagePath, options)),
  );
  return compositeLayers(layers, options.canvas);
}
