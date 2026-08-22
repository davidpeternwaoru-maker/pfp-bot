/**
 * Per-member, per-project roll state.
 *
 * What a member is currently looking at, and nothing else. Nothing here is
 * authoritative: the database holds claims, this only holds an in-progress
 * combination that can be discarded at any time without loss.
 *
 * Deliberately free of any notion of *where* the roll is displayed. A message
 * id, a chat, a browser tab — those belong to whichever front end is showing
 * it, and keeping them here would mean a second front end had to pretend to
 * have a message id to use the same store.
 */

export interface RollSession {
  readonly memberId: number;
  readonly projectId: number;
  /** The combination currently on screen, in layer order. */
  readonly traitIds: readonly number[];
  /** Stamped by the store, never by the caller — see RollSessionInput. */
  readonly updatedAt: number;
}

/**
 * What a caller supplies. Freshness is the store's business: if callers passed
 * their own timestamp, one stale or zeroed value would silently make a live
 * session look expired.
 */
export type RollSessionInput = Omit<RollSession, 'updatedAt'>;

export interface RollSessionStore {
  get(memberId: number, projectId: number): Promise<RollSession | undefined>;
  set(state: RollSessionInput): Promise<void>;
  clear(memberId: number, projectId: number): Promise<void>;
}

export function sessionKey(memberId: number, projectId: number): string {
  return `${String(memberId)}:${String(projectId)}`;
}

export interface InMemorySessionStoreOptions {
  /** Sessions older than this are treated as absent. */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * The interface is async and storage-agnostic so this can be swapped for Redis
 * or Postgres later without touching a single caller.
 */
export function createInMemorySessionStore(
  options: InMemorySessionStoreOptions = {},
): RollSessionStore & { size(): number } {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, RollSession>();

  const prune = (currentTime: number): void => {
    for (const [key, state] of sessions) {
      if (currentTime - state.updatedAt > maxAgeMs) {
        sessions.delete(key);
      }
    }
  };

  return {
    get(memberId: number, projectId: number): Promise<RollSession | undefined> {
      const currentTime = now();
      const key = sessionKey(memberId, projectId);
      const state = sessions.get(key);
      if (state === undefined) {
        return Promise.resolve(undefined);
      }
      // Expired state is dropped rather than returned stale: a member coming
      // back an hour later should start from a fresh roll.
      if (currentTime - state.updatedAt > maxAgeMs) {
        sessions.delete(key);
        return Promise.resolve(undefined);
      }
      return Promise.resolve(state);
    },

    set(state: RollSessionInput): Promise<void> {
      const currentTime = now();
      prune(currentTime);
      sessions.set(sessionKey(state.memberId, state.projectId), {
        ...state,
        updatedAt: currentTime,
      });
      return Promise.resolve();
    },

    clear(memberId: number, projectId: number): Promise<void> {
      sessions.delete(sessionKey(memberId, projectId));
      return Promise.resolve();
    },

    size(): number {
      return sessions.size;
    },
  };
}
