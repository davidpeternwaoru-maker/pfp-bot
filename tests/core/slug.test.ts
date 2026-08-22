import { describe, expect, it } from 'vitest';
import { MAX_SLUG_LENGTH, parseSlug } from '../../src/core/slug.js';

describe('parseSlug', () => {
  it('accepts a plain slug', () => {
    expect(parseSlug('pixelclub')).toEqual({ ok: true, slug: 'pixelclub' });
  });

  it('accepts digits and hyphens', () => {
    expect(parseSlug('drop-2-alpha')).toEqual({ ok: true, slug: 'drop-2-alpha' });
  });

  it('accepts a doubled hyphen, which the exact-match lookup makes harmless', () => {
    // Looks like an SQL comment, but the slug is only ever a bound parameter in
    // a findUnique, so there is no statement for it to comment out.
    expect(parseSlug('pixelclub--')).toEqual({ ok: true, slug: 'pixelclub--' });
  });

  it('treats a missing or empty payload as no project', () => {
    expect(parseSlug(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(parseSlug('')).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects anything longer than the cap', () => {
    expect(parseSlug('a'.repeat(MAX_SLUG_LENGTH))).toEqual({
      ok: true,
      slug: 'a'.repeat(MAX_SLUG_LENGTH),
    });
    expect(parseSlug('a'.repeat(MAX_SLUG_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it('rejects a megabyte of junk on length alone', () => {
    expect(parseSlug('x'.repeat(1_000_000)).ok).toBe(false);
  });

  it.each([
    ['uppercase', 'Pixelclub'],
    ['underscore', 'my_project'],
    ['space', 'my project'],
    ['sql-ish quote', "pixelclub' or '1'='1"],
    ['wildcard', 'pixel%'],
    ['path traversal', '../../etc/passwd'],
    ['forward slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['null byte', 'pixelclub\u0000'],
    ['newline', 'pixelclub\n'],
    ['unicode lookalike', 'yankа'],
    ['emoji', 'pixelclub🎨'],
    ['dot', 'pixelclub.slug'],
  ])('rejects %s', (_label, input) => {
    expect(parseSlug(input)).toEqual({ ok: false, reason: 'invalid-characters' });
  });
});
