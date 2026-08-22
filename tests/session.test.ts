import { describe, expect, it } from 'vitest';
import { createInMemorySessionStore, sessionKey } from '../src/bot/session.js';
import type { SessionInput } from '../src/bot/session.js';

function state(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    memberId: 1,
    projectId: 10,
    traitIds: [4, 5, 6],
    messageId: null,
    ...overrides,
  };
}

describe('sessionKey', () => {
  it('keys on member and project together', () => {
    expect(sessionKey(1, 10)).toBe(sessionKey(1, 10));
    expect(sessionKey(1, 10)).not.toBe(sessionKey(1, 11));
    expect(sessionKey(1, 10)).not.toBe(sessionKey(2, 10));
  });

  it('does not collide between different member/project splits', () => {
    // Guards the separator: (1, 210) and (12, 10) must not share a key.
    expect(sessionKey(1, 210)).not.toBe(sessionKey(12, 10));
  });
});

describe('createInMemorySessionStore', () => {
  it('returns what was stored', async () => {
    const store = createInMemorySessionStore();
    await store.set(state());
    await expect(store.get(1, 10)).resolves.toMatchObject(state());
  });

  it('stamps updatedAt itself rather than trusting the caller', async () => {
    const store = createInMemorySessionStore({ now: () => 12_345 });
    await store.set(state());
    await expect(store.get(1, 10)).resolves.toMatchObject({ updatedAt: 12_345 });
  });

  it('returns undefined for a member who has not rolled', async () => {
    const store = createInMemorySessionStore();
    await expect(store.get(99, 10)).resolves.toBeUndefined();
  });

  it('keeps a member’s sessions in different projects apart', async () => {
    const store = createInMemorySessionStore();
    await store.set(state({ projectId: 10, traitIds: [1] }));
    await store.set(state({ projectId: 20, traitIds: [2] }));

    await expect(store.get(1, 10)).resolves.toMatchObject({ traitIds: [1] });
    await expect(store.get(1, 20)).resolves.toMatchObject({ traitIds: [2] });
  });

  it('overwrites rather than accumulating on reroll', async () => {
    const store = createInMemorySessionStore();
    await store.set(state({ traitIds: [1] }));
    await store.set(state({ traitIds: [2] }));

    await expect(store.get(1, 10)).resolves.toMatchObject({ traitIds: [2] });
    expect(store.size()).toBe(1);
  });

  it('clears only the session asked for', async () => {
    const store = createInMemorySessionStore();
    await store.set(state({ projectId: 10 }));
    await store.set(state({ projectId: 20 }));

    await store.clear(1, 10);

    await expect(store.get(1, 10)).resolves.toBeUndefined();
    await expect(store.get(1, 20)).resolves.toBeDefined();
  });

  it('treats a stale session as absent instead of resuming it', async () => {
    let now = 0;
    const store = createInMemorySessionStore({ maxAgeMs: 1000, now: () => now });
    await store.set(state());

    now = 500;
    await expect(store.get(1, 10)).resolves.toBeDefined();

    now = 2000;
    await expect(store.get(1, 10)).resolves.toBeUndefined();
  });

  it('sweeps expired sessions rather than holding them forever', async () => {
    let now = 0;
    const store = createInMemorySessionStore({ maxAgeMs: 1000, now: () => now });

    for (let i = 0; i < 50; i += 1) {
      await store.set(state({ memberId: i }));
    }
    expect(store.size()).toBe(50);

    now = 5000;
    await store.set(state({ memberId: 999 }));
    expect(store.size()).toBe(1);
  });
});
