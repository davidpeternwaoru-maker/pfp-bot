import type { CommissionDraft } from './draft.js';

/**
 * Where a half-answered questionnaire lives.
 *
 * Same shape as the roll session store, and separate from it on purpose: a
 * member can be part-way through a commission brief while also rolling, and
 * one store holding both would make either flow able to destroy the other.
 *
 * Held for far longer than a roll. A roll abandoned for an hour should start
 * fresh — nothing was lost. A brief abandoned for an hour is somebody who went
 * to think about what they wanted, and making them answer four questions again
 * is the kind of small cruelty that ends orders.
 *
 * In memory, which means a restart discards drafts. That is the honest cost of
 * not adding a table for something nobody has paid for yet: no order exists
 * until the questionnaire is finished, so a lost draft costs answers rather
 * than money. If drafts start getting lost often enough to notice, the fix is
 * a table, not a longer timeout.
 */

export interface CommissionDraftStore {
  get(memberId: number, projectId: number): Promise<CommissionDraft | undefined>;
  set(draft: CommissionDraft): Promise<void>;
  clear(memberId: number, projectId: number): Promise<void>;
}

export interface DraftStoreOptions {
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

/** Long enough to go away, think, and come back to the same question. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function draftKey(memberId: number, projectId: number): string {
  return `${String(memberId)}:${String(projectId)}`;
}

interface Entry {
  readonly draft: CommissionDraft;
  readonly updatedAt: number;
}

export function createInMemoryDraftStore(
  options: DraftStoreOptions = {},
): CommissionDraftStore & { size(): number } {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const drafts = new Map<string, Entry>();

  const prune = (currentTime: number): void => {
    for (const [key, entry] of drafts) {
      if (currentTime - entry.updatedAt > maxAgeMs) {
        drafts.delete(key);
      }
    }
  };

  return {
    get(memberId: number, projectId: number): Promise<CommissionDraft | undefined> {
      const key = draftKey(memberId, projectId);
      const entry = drafts.get(key);
      if (entry === undefined) {
        return Promise.resolve(undefined);
      }
      if (now() - entry.updatedAt > maxAgeMs) {
        drafts.delete(key);
        return Promise.resolve(undefined);
      }
      return Promise.resolve(entry.draft);
    },

    set(draft: CommissionDraft): Promise<void> {
      const currentTime = now();
      prune(currentTime);
      drafts.set(draftKey(draft.memberId, draft.projectId), { draft, updatedAt: currentTime });
      return Promise.resolve();
    },

    clear(memberId: number, projectId: number): Promise<void> {
      drafts.delete(draftKey(memberId, projectId));
      return Promise.resolve();
    },

    size(): number {
      return drafts.size;
    },
  };
}
