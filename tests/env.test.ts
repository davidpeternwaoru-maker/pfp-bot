import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../src/config/env.js';

const VALID = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/pfpbot',
  TELEGRAM_BOT_TOKEN: '123456789:AAHfakefakefakefakefakefakefakefake1',
} as const;

function problemsOf(source: Record<string, string | undefined>): readonly string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error('expected parseEnv to reject');
}

/**
 * The keys that carry a default. Neither is a secret — falling back on one
 * cannot point the process at the wrong database or the wrong bot.
 */
const WITH_DEFAULTS = {
  ...VALID,
  LOG_LEVEL: 'info',
  TRAIT_ROOT: 'trait-packs',
  CLAIM_ROOT: 'output/claims',
} as const;

describe('parseEnv', () => {
  it('accepts a complete, well-formed environment', () => {
    expect(parseEnv({ ...VALID })).toEqual(WITH_DEFAULTS);
  });

  it('ignores unrelated variables rather than passing them through', () => {
    const parsed = parseEnv({ ...VALID, SOME_OTHER_VAR: 'x' });
    expect(parsed).toEqual(WITH_DEFAULTS);
  });

  it('takes an explicit LOG_LEVEL over the default', () => {
    expect(parseEnv({ ...VALID, LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug');
  });

  it('rejects an unknown LOG_LEVEL rather than quietly falling back', () => {
    expect(problemsOf({ ...VALID, LOG_LEVEL: 'verbose' }).join()).toContain('LOG_LEVEL');
  });

  it.each(['NODE_ENV', 'DATABASE_URL', 'TELEGRAM_BOT_TOKEN'] as const)(
    'refuses to start when %s is missing',
    (key) => {
      const source: Record<string, string | undefined> = { ...VALID };
      delete source[key];
      expect(problemsOf(source).join()).toContain(key);
    },
  );

  it('refuses an empty value as if it were absent', () => {
    expect(problemsOf({ ...VALID, TELEGRAM_BOT_TOKEN: '' }).join()).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(
      problemsOf({ ...VALID, DATABASE_URL: 'mysql://user:pass@localhost/db' }).join(),
    ).toContain('DATABASE_URL');
  });

  it('rejects a malformed bot token', () => {
    expect(problemsOf({ ...VALID, TELEGRAM_BOT_TOKEN: 'not-a-token' }).join()).toContain(
      'TELEGRAM_BOT_TOKEN',
    );
  });

  it('rejects an unknown NODE_ENV instead of defaulting it', () => {
    expect(problemsOf({ ...VALID, NODE_ENV: 'staging' }).join()).toContain('NODE_ENV');
  });

  it('never repeats a rejected value in the error, because it may be a secret', () => {
    const secret = '987654321:SUPERSECRETVALUETHATMUSTNOTLEAK000000';
    const source = { ...VALID, TELEGRAM_BOT_TOKEN: `"${secret}"` };

    let raised: EnvValidationError | undefined;
    try {
      parseEnv(source);
    } catch (error) {
      raised = error instanceof EnvValidationError ? error : undefined;
    }

    expect(raised).toBeInstanceOf(EnvValidationError);
    expect(raised?.message).not.toContain(secret);
    expect(raised?.problems.join()).not.toContain(secret);
  });
});

describe('TRAIT_ROOT', () => {
  it('defaults when unset, since a wrong path fails loudly at render time', () => {
    expect(parseEnv({ ...VALID }).TRAIT_ROOT).toBe('trait-packs');
  });

  it('takes an explicit value', () => {
    expect(parseEnv({ ...VALID, TRAIT_ROOT: '/srv/packs' }).TRAIT_ROOT).toBe('/srv/packs');
  });

  it('rejects an empty value rather than silently defaulting it', () => {
    expect(problemsOf({ ...VALID, TRAIT_ROOT: '' }).join()).toContain('TRAIT_ROOT');
  });
});
