import { describe, expect, it } from 'vitest';
import { createShutdown } from '../../src/shutdown.js';
import { createLogger } from '../../src/logging/logger.js';

/**
 * Shutting down without dropping work.
 *
 * A deploy sends SIGTERM to a process that may be half-way through a claim.
 * The claim is the one operation where being interrupted is not recoverable
 * by trying again: the row either committed or it did not, and a member who
 * confirmed and was never told which is left holding a screenshot of artwork
 * that may or may not be theirs.
 *
 * So the order matters, and so does finishing. These tests pin both.
 */

const logger = createLogger({ level: 'error', write: () => undefined });

/** A step that takes time, and records when it started and finished. */
function slowStep(name: string, order: string[], ms: number): () => Promise<void> {
  return async () => {
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`${name}:done`);
  };
}

describe('graceful shutdown', () => {
  it('finishes stopping the bot before touching the database', async () => {
    const order: string[] = [];

    await createShutdown({
      stopBot: slowStep('bot', order, 20),
      disconnectDatabase: slowStep('db', order, 1),
      logger,
    })('SIGTERM');

    // Not merely started in order — finished in order. Disconnecting while an
    // update was still running is how an in-flight claim loses its database
    // half-way through committing.
    expect(order).toEqual(['bot:start', 'bot:done', 'db:start', 'db:done']);
  });

  it('closes the signing page before the database too', async () => {
    const order: string[] = [];

    await createShutdown({
      stopBot: slowStep('bot', order, 5),
      stopHttp: slowStep('http', order, 5),
      disconnectDatabase: slowStep('db', order, 1),
      logger,
    })('SIGTERM');

    expect(order).toEqual([
      'bot:start',
      'bot:done',
      'http:start',
      'http:done',
      'db:start',
      'db:done',
    ]);
  });

  it('waits for a long in-flight update rather than returning early', async () => {
    const order: string[] = [];
    const started = Date.now();

    // Stands in for a claim queued behind the project row lock.
    await createShutdown({
      stopBot: slowStep('claim', order, 120),
      disconnectDatabase: slowStep('db', order, 1),
      logger,
    })('SIGTERM');

    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(order[1]).toBe('claim:done');
  });

  it('still closes the database when the bot refuses to stop', async () => {
    const order: string[] = [];

    await createShutdown({
      stopBot: () => Promise.reject(new Error('polling wedged')),
      disconnectDatabase: slowStep('db', order, 1),
      logger,
    })('SIGTERM');

    // A bot that fails to stop must not leave a connection open behind it.
    expect(order).toEqual(['db:start', 'db:done']);
  });

  it('runs once however many signals arrive', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      stopBot: slowStep('bot', order, 30),
      disconnectDatabase: slowStep('db', order, 1),
      logger,
    });

    // A deploy that sends SIGTERM twice, or an operator pressing Ctrl-C again
    // because the first one seemed slow. A second teardown running in parallel
    // would disconnect the database under the first one's feet.
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(order).toEqual(['bot:start', 'bot:done', 'db:start', 'db:done']);
  });

  it('completes even when every step fails', async () => {
    // Reporting a clean exit is what lets the platform stop waiting. A
    // shutdown that threw would look like a hang and be SIGKILLed.
    await expect(
      createShutdown({
        stopBot: () => Promise.reject(new Error('no')),
        stopHttp: () => Promise.reject(new Error('no')),
        disconnectDatabase: () => Promise.reject(new Error('no')),
        logger,
      })('SIGTERM'),
    ).resolves.toBeUndefined();
  });
});
