import type { Context } from 'grammy';
import { checkReference, MAX_REFERENCE_BYTES, readCapped } from '../../core/ports.js';
import type { ReferenceFormat, ReferenceRejection } from '../../core/ports.js';

/**
 * Fetching a file a member sent.
 *
 * Telegram hands back a path and a size it believes. Neither is trusted: the
 * size is checked against what actually arrives, and the bytes are checked
 * against their own header. The only thing taken on faith is the host, which
 * is fixed here rather than read from the reply — a path is not a URL, and
 * letting the reply choose where we fetch from would be letting it choose.
 */

export type UploadOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly format: ReferenceFormat }
  | { readonly ok: false; readonly rejection: ReferenceRejection };

/** Telegram's own ceiling for getFile is 20MB; ours is far below it. */
export async function downloadUpload(
  ctx: Context,
  token: string,
  fileId: string,
): Promise<UploadOutcome> {
  const file = await ctx.api.getFile(fileId);

  // The declared size is a claim, but a cheap one to act on: refusing here
  // saves fetching megabytes we would only discard.
  if (typeof file.file_size === 'number' && file.file_size > MAX_REFERENCE_BYTES) {
    return {
      ok: false,
      rejection: { kind: 'too-large', bytes: file.file_size, limit: MAX_REFERENCE_BYTES },
    };
  }

  const path = file.file_path;
  if (path === undefined) {
    return { ok: false, rejection: { kind: 'not-an-image' } };
  }

  // Fixed host, and the path is appended rather than parsed. Telegram controls
  // the path; it does not get to control where the request goes.
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${encodeURI(path)}`);

  if (!response.ok || response.body === null) {
    return { ok: false, rejection: { kind: 'not-an-image' } };
  }

  // The cap applied to what arrives, not to what was promised.
  const bytes = await readCapped(response.body);
  if (bytes === null) {
    return {
      ok: false,
      rejection: { kind: 'too-large', bytes: MAX_REFERENCE_BYTES, limit: MAX_REFERENCE_BYTES },
    };
  }

  const checked = checkReference(bytes);
  return checked.ok
    ? { ok: true, bytes, format: checked.format }
    : { ok: false, rejection: checked.rejection };
}

/** Says what was wrong and what would work, never merely that it failed. */
export function uploadRejectionReply(rejection: ReferenceRejection): string {
  switch (rejection.kind) {
    case 'too-large':
      return `That image is too large. The limit is ${String(Math.round(rejection.limit / (1024 * 1024)))}MB — send a smaller one.`;
    case 'empty':
      return 'That file was empty. Try sending it again.';
    case 'not-an-image':
      return 'I can only accept a PNG or JPEG image. Send a photo rather than a file of another kind.';
  }
}
