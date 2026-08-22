import { describe, expect, it } from 'vitest';
import { normaliseUsername, parseStartPayload } from '../../../src/adapters/telegram/payload.js';

describe('parseStartPayload', () => {
  it('applies the shared slug rule', () => {
    expect(parseStartPayload('my-drop')).toEqual({ ok: true, slug: 'my-drop' });
    expect(parseStartPayload('Bad Slug').ok).toBe(false);
    expect(parseStartPayload(undefined)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('normaliseUsername', () => {
  it('keeps a well-formed handle', () => {
    expect(normaliseUsername('some_user1')).toBe('some_user1');
  });

  it('drops anything Telegram would not issue rather than storing it', () => {
    expect(normaliseUsername('has spaces')).toBeNull();
    expect(normaliseUsername('a'.repeat(33))).toBeNull();
    expect(normaliseUsername('<script>')).toBeNull();
    expect(normaliseUsername('')).toBeNull();
  });

  it('treats absent as null', () => {
    expect(normaliseUsername(undefined)).toBeNull();
    expect(normaliseUsername(null)).toBeNull();
  });
});
