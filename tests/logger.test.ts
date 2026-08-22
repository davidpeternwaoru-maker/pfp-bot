import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.js';
import type { LogLevel } from '../src/logging/logger.js';

function capture(level: LogLevel): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    write: (line) => lines.push(line),
    now: () => new Date('2026-06-01T00:00:00Z'),
  });
  return { lines, logger };
}

function parsed(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe('createLogger', () => {
  it('emits one JSON object per line', () => {
    const { lines, logger } = capture('info');
    logger.info('bot.started', { botId: 7 });

    expect(lines).toHaveLength(1);
    expect(parsed(lines[0] ?? '')).toEqual({
      time: '2026-06-01T00:00:00.000Z',
      level: 'info',
      event: 'bot.started',
      botId: 7,
    });
  });

  it('drops anything below the configured level', () => {
    const { lines, logger } = capture('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');

    expect(lines.map((line) => parsed(line)['event'])).toEqual(['c', 'd']);
  });

  it('stamps child fields onto every line', () => {
    const { lines, logger } = capture('info');
    logger.child({ memberId: 3 }).info('start.resolved', { outcome: 'ready' });

    expect(parsed(lines[0] ?? '')).toMatchObject({ memberId: 3, outcome: 'ready' });
  });

  it('redacts message content, so a log can never become a transcript', () => {
    const { lines, logger } = capture('info');
    logger.info('handler.failed', { text: 'a private message', caption: 'secret' });

    const line = lines[0] ?? '';
    expect(line).not.toContain('a private message');
    expect(line).not.toContain('secret');
    expect(parsed(line)['text']).toBe('[redacted]');
  });

  it('redacts personal data and credentials by field name', () => {
    const { lines, logger } = capture('info');
    logger.info('event', {
      username: 'someone',
      firstName: 'Real Name',
      token: '123:abc',
      databaseUrl: 'postgres://u:p@h/db',
    });

    const line = lines[0] ?? '';
    for (const leaked of ['someone', 'Real Name', '123:abc', 'postgres://']) {
      expect(line).not.toContain(leaked);
    }
  });

  it('redacts regardless of the casing a caller used', () => {
    const { lines, logger } = capture('info');
    logger.info('event', { USERNAME: 'someone', FirstName: 'Real Name' });

    expect(lines[0] ?? '').not.toContain('someone');
    expect(lines[0] ?? '').not.toContain('Real Name');
  });

  it('redacts a bound child field too, not only per-call fields', () => {
    const { lines, logger } = capture('info');
    logger.child({ username: 'someone' }).info('event');

    expect(lines[0] ?? '').not.toContain('someone');
  });

  it('keeps identifiers that are safe to correlate on', () => {
    const { lines, logger } = capture('info');
    logger.info('start.resolved', { memberId: 12, projectId: 3, outcome: 'ready' });

    expect(parsed(lines[0] ?? '')).toMatchObject({ memberId: 12, projectId: 3, outcome: 'ready' });
  });
});
