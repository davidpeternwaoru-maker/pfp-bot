import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../src/shutdown.js';
import { createLogger } from '../src/logging/logger.js';

/** The JSON shape createLogger emits, as far as these tests care. */
interface LogLine {
  readonly event: string;
  readonly reason?: string;
}

function capturingLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (line: string) => lines.push(line) });
  return { logger, lines };
}

function eventsFrom(lines: readonly string[]): string[] {
  return lines.map((line) => (JSON.parse(line) as LogLine).event);
}

describe('createShutdown', () => {
  it('stops the bot before disconnecting the database', async () => {
    const order: string[] = [];
    const { logger } = capturingLogger();

    const shutdown = createShutdown({
      stopBot: async () => {
        await Promise.resolve();
        order.push('bot');
      },
      disconnectDatabase: async () => {
        await Promise.resolve();
        order.push('db');
      },
      logger,
    });

    await shutdown('SIGTERM');

    // An in-flight update must finish before the connection it is using goes.
    expect(order).toEqual(['bot', 'db']);
  });

  it('runs once even when the signal arrives twice', async () => {
    const stopBot = vi.fn(() => Promise.resolve());
    const disconnectDatabase = vi.fn(() => Promise.resolve());
    const { logger } = capturingLogger();

    const shutdown = createShutdown({ stopBot, disconnectDatabase, logger });

    await Promise.all([shutdown('SIGINT'), shutdown('SIGINT'), shutdown('SIGTERM')]);

    expect(stopBot).toHaveBeenCalledTimes(1);
    expect(disconnectDatabase).toHaveBeenCalledTimes(1);
  });

  it('still closes the database when stopping the bot fails', async () => {
    const disconnectDatabase = vi.fn(() => Promise.resolve());
    const { logger, lines } = capturingLogger();

    const shutdown = createShutdown({
      stopBot: () => Promise.reject(new Error('telegram unreachable')),
      disconnectDatabase,
      logger,
    });

    await shutdown('SIGTERM');

    // Otherwise a failed stop leaks the connection on every restart.
    expect(disconnectDatabase).toHaveBeenCalledTimes(1);
    expect(eventsFrom(lines)).toContain('shutdown.bot_stop_failed');
    expect(eventsFrom(lines)).toContain('shutdown.complete');
  });

  it('completes even when disconnecting fails', async () => {
    const { logger, lines } = capturingLogger();

    const shutdown = createShutdown({
      stopBot: () => Promise.resolve(),
      disconnectDatabase: () => Promise.reject(new Error('already closed')),
      logger,
    });

    await expect(shutdown('SIGTERM')).resolves.toBeUndefined();
    expect(eventsFrom(lines)).toContain('shutdown.disconnect_failed');
  });

  it('never puts the failure reason anywhere but the log', async () => {
    const { logger, lines } = capturingLogger();

    const shutdown = createShutdown({
      stopBot: () => Promise.reject(new Error('boom')),
      disconnectDatabase: () => Promise.resolve(),
      logger,
    });

    await shutdown('SIGINT');

    const failure = lines
      .map((line) => JSON.parse(line) as LogLine)
      .find((line) => line.event === 'shutdown.bot_stop_failed');

    expect(failure?.['reason']).toBe('boom');
  });
});
