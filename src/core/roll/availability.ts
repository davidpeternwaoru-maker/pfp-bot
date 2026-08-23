import { loadClaimedHashes } from '../db/claim-repository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Which combinations are taken, cached briefly, for telling a member what is
 * still free while they browse.
 *
 * This exists only to answer a question on screen. It is never what decides a
 * claim: that is settled by a unique index at insert time, and it stays settled
 * there. Drawing that line is what makes caching safe at all — the worst a
 * stale entry can do is show an optimistic tick for a second or two, after
 * which the member is told plainly that somebody got there first and is handed
 * a free combination.
 *
 * Without it, indicating availability would mean a database round trip on every
 * button press, and a member tapping through a forty-option slot would generate
 * forty scans of the same table. The cache is the debounce.
 */

export interface AvailabilityOptions {
  /** How long an answer may be reused. Short: it is shown, not enforced. */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

export interface Availability {
  claimedHashes(projectId: number): Promise<ReadonlySet<string>>;
  /** Drops a project's entry, so the next read is fresh. */
  invalidate(projectId: number): void;
}

/**
 * Long enough that a burst of taps costs one query, short enough that a member
 * who pauses to think sees the truth rather than a stale tick.
 */
const DEFAULT_MAX_AGE_MS = 3_000;

interface Entry {
  readonly loadedAt: number;
  readonly hashes: ReadonlySet<string>;
}

export function createAvailability(
  prisma: PrismaClient,
  options: AvailabilityOptions = {},
): Availability {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;

  const entries = new Map<number, Entry>();
  // Concurrent taps share one query rather than each starting their own. Two
  // members rolling the same project at once is the normal case, not the edge.
  const inFlight = new Map<number, Promise<ReadonlySet<string>>>();

  return {
    async claimedHashes(projectId: number): Promise<ReadonlySet<string>> {
      const entry = entries.get(projectId);
      if (entry !== undefined && now() - entry.loadedAt <= maxAgeMs) {
        return entry.hashes;
      }

      const pending = inFlight.get(projectId);
      if (pending !== undefined) {
        return pending;
      }

      const load = loadClaimedHashes(prisma, projectId)
        .then((hashes) => {
          entries.set(projectId, { loadedAt: now(), hashes });
          return hashes;
        })
        .finally(() => {
          inFlight.delete(projectId);
        });

      inFlight.set(projectId, load);
      return load;
    },

    invalidate(projectId: number): void {
      entries.delete(projectId);
    },
  };
}
