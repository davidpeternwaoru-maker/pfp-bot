import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
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
 * Resolves a stored path against the pack root and refuses anything that
 * escapes it — including via a symlink, which is why the check runs again on
 * the real path. Stored paths are admin-supplied, not member-supplied, but a
 * bad trait import must not become arbitrary file read.
 */
async function resolveWithinRoot(root: string, imagePath: string): Promise<string> {
  const realRoot = await realpath(resolve(root));
  const candidate = resolve(realRoot, imagePath);

  const escapes = (target: string): boolean => {
    const rel = relative(realRoot, target);
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  };

  if (escapes(candidate)) {
    throw new TraitImageError(imagePath, 'resolves outside the trait pack root');
  }

  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new TraitImageError(imagePath, 'file does not exist');
  }

  if (escapes(real)) {
    throw new TraitImageError(imagePath, 'links outside the trait pack root');
  }

  return real;
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
  const absolute = await resolveWithinRoot(options.root, imagePath);

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
