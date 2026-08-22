import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Confines a caller-supplied path to a root directory.
 *
 * Shared rather than duplicated because it is the single check standing
 * between an operator's typo — or a crafted trait pack — and reading files
 * from anywhere on the host. Two copies of a rule like this drift, and the
 * copy that drifts is the one nobody tested.
 */

export type ContainmentFailure = 'escapes-root' | 'missing' | 'links-outside';

export type ContainmentResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: ContainmentFailure };

function escapes(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Resolves `candidate` under `root` and refuses anything that leaves it.
 *
 * The check runs twice: once on the resolved path, and again after realpath,
 * because a path that looks contained can still be a link pointing elsewhere.
 */
export async function resolveWithinRoot(
  root: string,
  candidate: string,
): Promise<ContainmentResult> {
  const realRoot = await realpath(resolve(root));
  const target = resolve(realRoot, candidate);

  if (escapes(realRoot, target)) {
    return { ok: false, reason: 'escapes-root' };
  }

  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return { ok: false, reason: 'missing' };
  }

  if (escapes(realRoot, real)) {
    return { ok: false, reason: 'links-outside' };
  }

  return { ok: true, path: real };
}
