import { describe, expect, it } from 'vitest';
import { resolveEntry } from '../src/bot/entry.js';
import type { EntryProject } from '../src/bot/entry.js';
import { entryReply } from '../src/bot/replies.js';

const NOW = new Date('2026-06-01T12:00:00Z');

function project(overrides: Partial<EntryProject> = {}): EntryProject {
  return {
    id: 1,
    name: 'Test Collection',
    status: 'live',
    claimOpensAt: null,
    claimClosesAt: null,
    ...overrides,
  };
}

describe('resolveEntry', () => {
  it('reports an unknown project when no project was found', () => {
    expect(resolveEntry({ project: null, existingClaim: null, now: NOW })).toEqual({
      kind: 'unknown-project',
    });
  });

  it.each(['draft', 'closed'] as const)('reports a %s project as not open', (status) => {
    const outcome = resolveEntry({ project: project({ status }), existingClaim: null, now: NOW });
    expect(outcome).toEqual({ kind: 'not-open', projectName: 'Test Collection', status });
  });

  it('reports an existing claim with its edition number', () => {
    const outcome = resolveEntry({
      project: project(),
      existingClaim: { editionNumber: 42 },
      now: NOW,
    });
    expect(outcome).toEqual({
      kind: 'already-claimed',
      projectName: 'Test Collection',
      editionNumber: 42,
    });
  });

  it('is ready when the project is live and the member has not claimed', () => {
    expect(resolveEntry({ project: project(), existingClaim: null, now: NOW })).toEqual({
      kind: 'ready',
      projectId: 1,
      projectName: 'Test Collection',
    });
  });

  it('holds a member back before the window opens', () => {
    const opensAt = new Date('2026-06-02T00:00:00Z');
    const outcome = resolveEntry({
      project: project({ claimOpensAt: opensAt }),
      existingClaim: null,
      now: NOW,
    });
    expect(outcome).toEqual({ kind: 'not-yet-open', projectName: 'Test Collection', opensAt });
  });

  it('turns a member away after the window closes', () => {
    const outcome = resolveEntry({
      project: project({ claimClosesAt: new Date('2026-05-31T00:00:00Z') }),
      existingClaim: null,
      now: NOW,
    });
    expect(outcome.kind).toBe('window-closed');
  });

  it('lets a member inside an open window through', () => {
    const outcome = resolveEntry({
      project: project({
        claimOpensAt: new Date('2026-05-01T00:00:00Z'),
        claimClosesAt: new Date('2026-07-01T00:00:00Z'),
      }),
      existingClaim: null,
      now: NOW,
    });
    expect(outcome.kind).toBe('ready');
  });

  it('still shows an existing claim after the window has closed', () => {
    const outcome = resolveEntry({
      project: project({ claimClosesAt: new Date('2026-05-31T00:00:00Z') }),
      existingClaim: { editionNumber: 7 },
      now: NOW,
    });
    expect(outcome.kind).toBe('already-claimed');
  });

  it('treats the closing instant as closed, so the boundary is not double-served', () => {
    const closesAt = new Date(NOW);
    const outcome = resolveEntry({
      project: project({ claimClosesAt: closesAt }),
      existingClaim: null,
      now: NOW,
    });
    expect(outcome.kind).toBe('window-closed');
  });
});

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
