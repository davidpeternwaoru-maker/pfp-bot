/**
 * Per-user rate limiting.
 *
 * Rolling and rendering are CPU-bound, so an unthrottled user is a cheap way
 * to exhaust the process. The limiter is deliberately in front of every
 * handler rather than only the expensive ones: a handler added later must be
 * covered by default, not by remembering to opt in.
 */

export interface RateLimiterOptions {
  /** Actions allowed per window. */
  readonly limit: number;
  readonly windowMs: number;
  /** Injectable so tests can advance time without waiting. */
  readonly now?: () => number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole seconds until the window resets. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
  /** Number of tracked keys; exposed so tests can prove pruning happens. */
  size(): number;
}

interface Window {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (options.limit < 1) {
    throw new RangeError('rate limit must allow at least one action per window');
  }

  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();

  // Expired entries are swept whenever the map grows past this, so a stream of
  // one-off users cannot grow it without bound.
  const PRUNE_THRESHOLD = 1024;

  const prune = (currentTime: number): void => {
    for (const [key, window] of windows) {
      if (window.resetAt <= currentTime) {
        windows.delete(key);
      }
    }
  };

  return {
    check(key: string): RateLimitDecision {
      const currentTime = now();

      if (windows.size > PRUNE_THRESHOLD) {
        prune(currentTime);
      }

      const existing = windows.get(key);
      if (existing === undefined || existing.resetAt <= currentTime) {
        windows.set(key, { count: 1, resetAt: currentTime + options.windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (existing.count >= options.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - currentTime) / 1000)),
        };
      }

      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },

    size(): number {
      return windows.size;
    },
  };
}
