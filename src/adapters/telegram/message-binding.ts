/**
 * Which Telegram message is currently showing a member's roll.
 *
 * This is the half of the old session that was Telegram's business. Core keeps
 * *what* a member is looking at; this keeps *where* it is being displayed, so
 * a second front end can reuse the roll state without inventing a message id.
 *
 * It also carries the security property the roll depends on: a button press
 * arrives with attacker-controlled callback data and no trustworthy project
 * id, so the message being edited is the anchor that ties the press back to
 * server-side state.
 */

export interface MessageBinding {
  readonly memberId: number;
  readonly projectId: number;
  readonly messageId: number;
  readonly boundAt: number;
}

export interface MessageBindingStore {
  /** The project a member's message is showing, if any. */
  findProject(memberId: number, messageId: number): Promise<number | undefined>;
  /** The message currently showing a member's roll for a project, if any. */
  messageFor(memberId: number, projectId: number): Promise<number | undefined>;
  bind(memberId: number, projectId: number, messageId: number): Promise<void>;
  release(memberId: number, projectId: number): Promise<void>;
}

export interface MessageBindingOptions {
  /** Bindings older than this are treated as absent. */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export function createInMemoryMessageBindings(
  options: MessageBindingOptions = {},
): MessageBindingStore & { size(): number } {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const bindings = new Map<string, MessageBinding>();

  const key = (memberId: number, projectId: number): string =>
    `${String(memberId)}:${String(projectId)}`;

  return {
    findProject(memberId: number, messageId: number): Promise<number | undefined> {
      const currentTime = now();
      for (const binding of bindings.values()) {
        if (binding.memberId !== memberId || binding.messageId !== messageId) {
          continue;
        }
        if (currentTime - binding.boundAt > maxAgeMs) {
          bindings.delete(key(binding.memberId, binding.projectId));
          return Promise.resolve(undefined);
        }
        return Promise.resolve(binding.projectId);
      }
      return Promise.resolve(undefined);
    },

    messageFor(memberId: number, projectId: number): Promise<number | undefined> {
      const binding = bindings.get(key(memberId, projectId));
      if (binding === undefined) {
        return Promise.resolve(undefined);
      }
      if (now() - binding.boundAt > maxAgeMs) {
        bindings.delete(key(memberId, projectId));
        return Promise.resolve(undefined);
      }
      return Promise.resolve(binding.messageId);
    },

    bind(memberId: number, projectId: number, messageId: number): Promise<void> {
      const currentTime = now();
      for (const [existing, binding] of bindings) {
        if (currentTime - binding.boundAt > maxAgeMs) {
          bindings.delete(existing);
        }
      }
      bindings.set(key(memberId, projectId), {
        memberId,
        projectId,
        messageId,
        boundAt: currentTime,
      });
      return Promise.resolve();
    },

    release(memberId: number, projectId: number): Promise<void> {
      bindings.delete(key(memberId, projectId));
      return Promise.resolve();
    },

    size(): number {
      return bindings.size;
    },
  };
}
