import { describe, expect, it } from 'vitest';
import { createAvailability } from '../../src/core/roll/availability.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * The cache is the debounce.
 *
 * Indicating whether a combination is free means asking on every tap, and a
 * member walking a forty-option slot would otherwise scan the same table forty
 * times. What this file pins down is that the saving is real, that concurrent
 * taps share one query rather than racing, and that a claim drops the answer
 * immediately — a stale tick is tolerable for a second, but not after this
 * process has itself watched the combination go.
 */

interface Recorder {
  readonly prisma: PrismaClient;
  queries(): number;
  setHashes(hashes: readonly string[]): void;
  /** Makes every query wait until `release` is called. */
  hold(): void;
  release(): void;
}

/** A prisma stand-in that counts findMany calls and can be held mid-flight. */
function recorder(initial: readonly string[] = []): Recorder {
  let count = 0;
  let hashes = [...initial];
  let held = false;
  const waiting: (() => void)[] = [];

  const stub = {
    claim: {
      findMany: async (): Promise<{ combinationHash: string }[]> => {
        count += 1;
        if (held) {
          await new Promise<void>((resolve) => waiting.push(resolve));
        }
        return hashes.map((combinationHash) => ({ combinationHash }));
      },
    },
  };

  return {
    prisma: stub as unknown as PrismaClient,
    queries: () => count,
    setHashes: (next) => {
      hashes = [...next];
    },
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      while (waiting.length > 0) {
        waiting.pop()?.();
      }
    },
  };
}

describe('availability', () => {
  it('answers a burst of taps from one query', async () => {
    const source = recorder(['aaa']);
    let clock = 0;
    const availability = createAvailability(source.prisma, { maxAgeMs: 3_000, now: () => clock });

    for (let tap = 0; tap < 40; tap += 1) {
      clock += 20;
      const hashes = await availability.claimedHashes(1);
      expect(hashes.has('aaa')).toBe(true);
    }

    // Forty taps over 800ms. Without the cache this is forty table scans.
    expect(source.queries()).toBe(1);
  });

  it('makes concurrent taps share one query instead of racing', async () => {
    const source = recorder(['aaa']);
    const availability = createAvailability(source.prisma, { maxAgeMs: 3_000, now: () => 0 });

    // Nothing is cached yet and the query is held open, so every one of these
    // arrives while the first is still in flight. Two members rolling the same
    // project at the same moment is the normal case, not the edge.
    source.hold();
    const inFlight = Array.from({ length: 8 }, () => availability.claimedHashes(1));
    source.release();

    const answers = await Promise.all(inFlight);

    expect(source.queries()).toBe(1);
    for (const answer of answers) {
      expect(answer.has('aaa')).toBe(true);
    }

    // And the shared query still populated the cache for whoever comes next.
    await availability.claimedHashes(1);
    expect(source.queries()).toBe(1);
  });

  it('asks again once the answer is old enough to mislead', async () => {
    const source = recorder(['aaa']);
    let clock = 0;
    const availability = createAvailability(source.prisma, { maxAgeMs: 3_000, now: () => clock });

    await availability.claimedHashes(1);
    clock = 2_999;
    await availability.claimedHashes(1);
    expect(source.queries()).toBe(1);

    clock = 3_001;
    source.setHashes(['aaa', 'bbb']);
    const fresh = await availability.claimedHashes(1);

    expect(source.queries()).toBe(2);
    expect(fresh.has('bbb')).toBe(true);
  });

  it('keeps projects apart', async () => {
    const source = recorder(['aaa']);
    const availability = createAvailability(source.prisma, { maxAgeMs: 3_000, now: () => 0 });

    await availability.claimedHashes(1);
    await availability.claimedHashes(2);

    // A cached answer for one project must never be served for another; that
    // would tell a member their combination was taken in a drop they are not in.
    expect(source.queries()).toBe(2);
  });

  it('drops the answer as soon as a claim lands', async () => {
    const source = recorder(['aaa']);
    const availability = createAvailability(source.prisma, { maxAgeMs: 60_000, now: () => 0 });

    await availability.claimedHashes(1);
    source.setHashes(['aaa', 'bbb']);

    // Still cached, and would stay cached for a minute.
    expect((await availability.claimedHashes(1)).has('bbb')).toBe(false);

    availability.invalidate(1);

    // This process has just watched a claim commit. Showing a tick for it now
    // would be advertising something it knows is gone.
    expect((await availability.claimedHashes(1)).has('bbb')).toBe(true);
    expect(source.queries()).toBe(2);
  });
});
