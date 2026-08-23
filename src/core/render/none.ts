import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { transparentCanvas } from './image.js';
import type { CanvasSize } from './types.js';

/**
 * The "none" option every slot carries, so a member can have no hat, no
 * clothes, no mouth.
 *
 * It is an ordinary trait row pointing at a transparent canvas-sized PNG, and
 * that is the entire design. Nothing in the selector, the renderer, the
 * hasher, the sweep or the capacity count knows it exists. A branch on "is
 * this the none option" would be a branch all five would have to keep getting
 * right forever, and it would buy nothing: an empty layer already composites
 * to the result the branch would have to produce, and an ordinary trait id
 * already hashes into the combination that makes "no hat" unique.
 */
export const NONE_TRAIT_NAME = 'none';

/**
 * One file per canvas size, shared by every slot and every project that size.
 *
 * The bytes are identical whatever slot points at them, so writing one copy
 * per slot would be N identical files for no gain. The leading underscore
 * keeps it out of the pack scanner, which reads only directories named
 * "<layerOrder>-<slot>".
 */
export function noneImagePath(canvas: CanvasSize): string {
  return `_none/transparent-${String(canvas.width)}x${String(canvas.height)}.png`;
}

/**
 * Writes the transparent layer under a pack root and returns its stored path.
 *
 * Written unconditionally rather than only when absent: the encoder is
 * deterministic, so this either changes nothing or repairs a file somebody
 * damaged. Idempotent, and safe to call on every import.
 */
export async function ensureNoneImage(root: string, canvas: CanvasSize): Promise<string> {
  const relativePath = noneImagePath(canvas);
  const absolutePath = resolve(root, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, await transparentCanvas(canvas));

  return relativePath;
}
