import { rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkReference,
  MAX_REFERENCE_BYTES,
  readCapped,
  saveReference,
} from '../../src/core/commission/reference.js';
import { makeTempRoot } from '../helpers/fixtures.js';

/**
 * Files a member sends.
 *
 * Everything about one is attacker-controlled: the bytes, the size claimed for
 * it, and the name it arrives under. So the tests here are the ones that would
 * catch any of those being believed.
 */

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]);

let root: string | undefined;

afterAll(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
  }
});

/** A stream that yields the given chunks, as a download would. */
function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

describe('deciding what is an image', () => {
  it('accepts a real PNG and a real JPEG', () => {
    expect(checkReference(PNG)).toEqual({ ok: true, format: 'png' });
    expect(checkReference(JPEG)).toEqual({ ok: true, format: 'jpg' });
  });

  it('judges by the header, never by what the file claims to be', () => {
    // A .png that is really something else is the ordinary shape of this
    // attack, and the name never gets a vote because it is never consulted.
    const disguised = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]); // a Windows exe
    expect(checkReference(disguised).ok).toBe(false);

    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
    expect(checkReference(zip).ok).toBe(false);

    const svg = new TextEncoder().encode('<svg onload="alert(1)">');
    expect(checkReference(svg).ok).toBe(false);
  });

  it('refuses a header that only nearly matches', () => {
    const nearly = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]);
    expect(checkReference(nearly).ok).toBe(false);
  });

  it('refuses an empty file rather than storing nothing', () => {
    const result = checkReference(new Uint8Array(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.kind).toBe('empty');
    }
  });

  it('refuses one over the size limit', () => {
    const huge = new Uint8Array(MAX_REFERENCE_BYTES + 1);
    huge.set(PNG.subarray(0, 8));

    const result = checkReference(huge);
    expect(result.ok).toBe(false);
    if (!result.ok && result.rejection.kind === 'too-large') {
      expect(result.rejection.limit).toBe(MAX_REFERENCE_BYTES);
    }
  });
});

describe('reading a download', () => {
  it('reassembles chunks in order', async () => {
    const bytes = await readCapped(streamOf([PNG.subarray(0, 4), PNG.subarray(4)]));
    expect(bytes).toEqual(PNG);
  });

  it('stops at the cap rather than reading whatever arrives', async () => {
    // The cap applies to what actually arrives, not to the length a sender
    // declared — a declared length is a claim like any other.
    const chunk = new Uint8Array(1024);
    const forever = Array.from({ length: 40 }, () => chunk);

    const bytes = await readCapped(streamOf(forever), 4096);
    expect(bytes).toBeNull();
  });

  it('accepts a stream that fits exactly', async () => {
    const bytes = await readCapped(streamOf([new Uint8Array(100)]), 100);
    expect(bytes?.length).toBe(100);
  });
});

describe('storing one', () => {
  it('never uses a name anything outside chose', async () => {
    root = await makeTempRoot();

    const first = await saveReference(root, 7, 42, PNG, 'png');
    const second = await saveReference(root, 7, 42, PNG, 'png');

    // Generated names, so there is no path to traverse and nothing of one
    // member's that another can overwrite by picking the same filename.
    expect(first).not.toBe(second);
    expect(first).toMatch(/^references\/7\/42-[0-9a-f]{16}\.png$/);

    // And the bytes really are there.
    expect(new Uint8Array(await readFile(resolve(root, first)))).toEqual(PNG);
  });

  it('keeps projects apart', async () => {
    root = await makeTempRoot();

    const a = await saveReference(root, 1, 5, PNG, 'png');
    const b = await saveReference(root, 2, 5, JPEG, 'jpg');

    expect(a).toContain('references/1/');
    expect(b).toContain('references/2/');
    expect(b).toMatch(/\.jpg$/);
  });

  it('takes its extension from the verified format, not from the sender', async () => {
    root = await makeTempRoot();

    // The bytes are a JPEG; nothing the sender said is consulted at all.
    const stored = await saveReference(root, 1, 1, JPEG, 'jpg');
    expect(stored).toMatch(/\.jpg$/);
  });
});
