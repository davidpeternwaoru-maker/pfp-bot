import type { Logger } from './logging/logger.js';

/**
 * Orderly teardown, kept out of the bootstrap so it can be tested.
 *
 * Signals are the one part of this that cannot be exercised on every platform
 * — Windows has no real SIGINT — so the logic lives here and the signal
 * handlers stay a single line each.
 */

export interface ShutdownSteps {
  /** Stopped first, so an in-flight update finishes before its database goes. */
  readonly stopBot: () => Promise<void>;
  readonly disconnectDatabase: () => Promise<void>;
  readonly logger: Logger;
}

export type Shutdown = (signal: string) => Promise<void>;

export function createShutdown(steps: ShutdownSteps): Shutdown {
  const { stopBot, disconnectDatabase, logger } = steps;
  let started = false;

  return async (signal: string): Promise<void> => {
    // A second Ctrl-C must not start a parallel teardown.
    if (started) {
      return;
    }
    started = true;

    logger.info('shutdown.started', { signal });

    // Each step is attempted regardless of what the previous one did. A bot
    // that fails to stop must not leave the database connection open behind it.
    try {
      await stopBot();
    } catch (error) {
      logger.error('shutdown.bot_stop_failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await disconnectDatabase();
    } catch (error) {
      logger.error('shutdown.disconnect_failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('shutdown.complete', { signal });
  };
}
