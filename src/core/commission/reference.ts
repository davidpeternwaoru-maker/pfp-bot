import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Taking a file from a member.
 *
 * Everything about an uploaded reference image is attacker-controlled: the
 * bytes, the size the sender claims it is, and the name it arrives under. So
 * none of those is trusted.
 *
 * The extension is a claim and the magic bytes are the evidence. The declared
 * size is a claim and the cap is applied to what actually arrives. And the
 * stored name is generated here rather than derived from anything sent, so
 * there is no path to traverse and no name to collide with somebody else's.
 *
 * This is not artwork that will be composited or hashed into a claim — it is a
 * picture an illustrator looks at. It is never rendered, never returned to
 * another member, and never used to build anything.
 */

/** Generous for a phone photo, small enough that a hostile one is cheap. */
export const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;

/** The eight bytes every PNG starts with. */
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** JPEG's start-of-image marker. */
const JPEG_MAGIC = Uint8Array.from([0xff, 0xd8, 0xff]);

export type ReferenceFormat = 'png' | 'jpg';

export type ReferenceRejection =
  | { readonly kind: 'too-large'; readonly bytes: number; readonly limit: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'not-an-image' };

export type ReferenceCheck =
  | { readonly ok: true; readonly format: ReferenceFormat }
  | { readonly ok: false; readonly rejection: ReferenceRejection };

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) {
    return false;
  }
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Whether these bytes are an image we will keep.
 *
 * PNG and JPEG only, decided by the header rather than by anything the sender
 * said. A file named .png that is really something else is the ordinary shape
 * of this attack, and the name never gets a vote.
 */
export function checkReference(bytes: Uint8Array): ReferenceCheck {
  if (bytes.length === 0) {
    return { ok: false, rejection: { kind: 'empty' } };
  }
  if (bytes.length > MAX_REFERENCE_BYTES) {
    return {
      ok: false,
      rejection: { kind: 'too-large', bytes: bytes.length, limit: MAX_REFERENCE_BYTES },
    };
  }
  if (startsWith(bytes, PNG_MAGIC)) {
    return { ok: true, format: 'png' };
  }
  if (startsWith(bytes, JPEG_MAGIC)) {
    return { ok: true, format: 'jpg' };
  }
  return { ok: false, rejection: { kind: 'not-an-image' } };
}

/**
 * Writes a checked reference and returns its stored path.
 *
 * The name is random and the extension comes from the verified format, so
 * nothing a sender chose reaches the filesystem. Kept per member and project
 * so one member's uploads can never overwrite another's.
 */
export async function saveReference(
  root: string,
  projectId: number,
  memberId: number,
  bytes: Uint8Array,
  format: ReferenceFormat,
): Promise<string> {
  const name = `${String(memberId)}-${randomBytes(8).toString('hex')}.${format}`;
  const relativePath = join('references', String(projectId), name);
  const absolutePath = resolve(root, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);

  return relativePath.split('\\').join('/');
}

/**
 * Reads a stream into memory, refusing to exceed the cap.
 *
 * The cap is applied to what actually arrives rather than to the length a
 * sender declared, because a declared length is a claim like any other. A
 * response that keeps producing bytes is abandoned rather than followed.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number = MAX_REFERENCE_BYTES,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > limit) {
        // Abandoned mid-download. Reading the rest to report the true size
        // would be doing the work the cap exists to avoid.
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
