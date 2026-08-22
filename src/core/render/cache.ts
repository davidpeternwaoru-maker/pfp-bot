/**
 * A short-lived cache of rendered images, keyed by project and combination
 * hash.
 *
 * Rerolling back and forth over the same handful of combinations is the normal
 * way people use this, and re-encoding a PNG each time is the most expensive
 * thing the process does. Bounded by both age and entry count, because the
 * buffers are large and this is a long-running process.
 */

export interface RenderCacheOptions {
  readonly maxEntries?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

export interface RenderCache {
  get(key: string): Buffer | undefined;
  set(key: string, image: Buffer): void;
  size(): number;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

interface Entry {
  readonly image: Buffer;
  readonly storedAt: number;
}

export function renderCacheKey(projectId: number, combinationHash: string): string {
  return `${String(projectId)}:${combinationHash}`;
}

export function createRenderCache(options: RenderCacheOptions = {}): RenderCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  return {
    get(key: string): Buffer | undefined {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }
      if (now() - entry.storedAt > maxAgeMs) {
        entries.delete(key);
        return undefined;
      }
      // Re-inserting marks it as most recently used, so the eviction below
      // drops the coldest entry rather than the oldest-inserted one.
      entries.delete(key);
      entries.set(key, entry);
      return entry.image;
    },

    set(key: string, image: Buffer): void {
      entries.delete(key);
      entries.set(key, { image, storedAt: now() });

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) {
          break;
        }
        entries.delete(oldest.value);
      }
    },

    size(): number {
      return entries.size;
    },
  };
}
