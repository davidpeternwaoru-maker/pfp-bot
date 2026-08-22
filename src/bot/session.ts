/**
 * Per-member, per-project roll state.
 *
 * The interface is async and storage-agnostic so the in-memory implementation
 * can be swapped for Redis or Postgres later without touching a single caller.
 * Nothing here is authoritative: the database holds claims, this only holds
 * what a member is currently looking at.
 */

export interface SessionState {
  readonly memberId: number;
  readonly projectId: number;
  /** The combination currently on screen, in layer order. */
  readonly traitIds: readonly number[];
  /** The message being edited in place, once one has been sent. */
  readonly messageId: number | null;
  /** Stamped by the store, never by the caller — see SessionInput. */
  readonly updatedAt: number;
}

/**
 * What a caller supplies. Freshness is the store's business: if callers passed
 * their own timestamp, one stale or zeroed value would silently make a live
 * session look expired.
 */
export type SessionInput = Omit<SessionState, 'updatedAt'>;

export interface SessionStore {
  get(memberId: number, projectId: number): Promise<SessionState | undefined>;
  set(state: SessionInput): Promise<void>;
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

export function createInMemorySessionStore(
  options: InMemorySessionStoreOptions = {},
): SessionStore & { size(): number } {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionState>();

  const prune = (currentTime: number): void => {
    for (const [key, state] of sessions) {
      if (currentTime - state.updatedAt > maxAgeMs) {
        sessions.delete(key);
      }
    }
  };

  return {
    get(memberId: number, projectId: number): Promise<SessionState | undefined> {
      const currentTime = now();
      const state = sessions.get(sessionKey(memberId, projectId));
      if (state === undefined) {
        return Promise.resolve(undefined);
      }
      // Expired state is dropped rather than returned stale: a member coming
      // back an hour later should start from a fresh roll.
      if (currentTime - state.updatedAt > maxAgeMs) {
        sessions.delete(sessionKey(memberId, projectId));
        return Promise.resolve(undefined);
      }
      return Promise.resolve(state);
    },

    set(state: SessionInput): Promise<void> {
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
