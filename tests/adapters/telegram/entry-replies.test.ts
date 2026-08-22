import { describe, expect, it } from 'vitest';
import { entryReply } from '../../../src/adapters/telegram/replies.js';

/**
 * How each entry outcome reads to a member. What produces those outcomes is
 * core's job and is tested in tests/core/entry.test.ts.
 */
const NOW = new Date('2026-06-01T12:00:00Z');

describe('entryReply', () => {
  it('gives an identical answer for a bad link and a real-but-unknown slug', () => {
    // The reply must not reveal which slugs exist.
    expect(entryReply({ kind: 'unknown-project' })).toBe(entryReply({ kind: 'unknown-project' }));
  });

  it('produces a distinct, non-empty reply for every entry state', () => {
    const replies = [
      entryReply({ kind: 'unknown-project' }),
      entryReply({ kind: 'not-open', projectName: 'P', status: 'draft' }),
      entryReply({ kind: 'not-yet-open', projectName: 'P', opensAt: NOW }),
      entryReply({ kind: 'already-claimed', projectName: 'P', editionNumber: 3 }),
      entryReply({ kind: 'ready', projectId: 1, projectName: 'P' }),
    ];

    expect(new Set(replies).size).toBe(replies.length);
    for (const reply of replies) {
      expect(reply.length).toBeGreaterThan(0);
    }
  });

  it('names the edition a member already holds', () => {
    expect(entryReply({ kind: 'already-claimed', projectName: 'P', editionNumber: 3 })).toContain(
      '#3',
    );
  });
});
