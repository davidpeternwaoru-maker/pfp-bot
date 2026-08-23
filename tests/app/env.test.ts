import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../../src/config/env.js';

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
  // Empty authorises nobody, which is the safe default for an allowlist.
  ADMIN_IDS: [],
  HTTP_PORT: 3000,
} as const;

/** A configured wallet setup: both halves, as the schema insists. */
const WITH_WALLET = {
  ...VALID,
  SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=not-a-real-key',
  PUBLIC_BASE_URL: 'https://pfp.example.com',
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

describe('ADMIN_IDS', () => {
  it('authorises nobody when unset, rather than everybody', () => {
    expect(parseEnv({ ...VALID }).ADMIN_IDS).toEqual([]);
  });

  it('parses a comma-separated list of platform-qualified ids', () => {
    expect(parseEnv({ ...VALID, ADMIN_IDS: 'telegram:123,discord:456' }).ADMIN_IDS).toEqual([
      { platform: 'telegram', externalId: '123' },
      { platform: 'discord', externalId: '456' },
    ]);
  });

  it('tolerates spacing and trailing separators', () => {
    expect(parseEnv({ ...VALID, ADMIN_IDS: ' telegram:123 , telegram:456 , ' }).ADMIN_IDS).toEqual([
      { platform: 'telegram', externalId: '123' },
      { platform: 'telegram', externalId: '456' },
    ]);
  });

  it('refuses a bare id with no platform', () => {
    // The same digits belong to different people on different front ends.
    expect(problemsOf({ ...VALID, ADMIN_IDS: '123' }).join()).toContain('ADMIN_IDS');
    expect(problemsOf({ ...VALID, ADMIN_IDS: 'nope:123' }).join()).toContain('ADMIN_IDS');
  });

  it('refuses to start on a malformed id rather than dropping it', () => {
    // Silently ignoring a typo would shrink the allowlist without anyone
    // noticing, which for an authorisation list is the wrong way to fail.
    expect(problemsOf({ ...VALID, ADMIN_IDS: '123,not-an-id' }).join()).toContain('ADMIN_IDS');
    expect(problemsOf({ ...VALID, ADMIN_IDS: '@someone' }).join()).toContain('ADMIN_IDS');
  });
  it('runs with no wallet configuration at all, because claiming needs none', () => {
    const parsed = parseEnv({ ...VALID });

    // Not a degraded mode. Wallet linking gates token features and nothing
    // else, so an operator who never intends to use them must not be forced
    // to configure an RPC endpoint to run a drop.
    expect(parsed.SOLANA_RPC_URL).toBeUndefined();
    expect(parsed.PUBLIC_BASE_URL).toBeUndefined();
  });

  it('accepts both halves of the wallet configuration together', () => {
    const parsed = parseEnv({ ...WITH_WALLET });
    expect(parsed.SOLANA_RPC_URL).toBe(WITH_WALLET.SOLANA_RPC_URL);
    expect(parsed.PUBLIC_BASE_URL).toBe(WITH_WALLET.PUBLIC_BASE_URL);
  });

  it('refuses half a wallet configuration, at startup rather than mid-flow', () => {
    // Either half alone is a feature that fails when a member first reaches
    // for it. Better to refuse to boot than to strand somebody part-way
    // through linking a wallet.
    expect(problemsOf({ ...VALID, SOLANA_RPC_URL: WITH_WALLET.SOLANA_RPC_URL }).join()).toContain(
      'must be set together',
    );
    expect(problemsOf({ ...VALID, PUBLIC_BASE_URL: WITH_WALLET.PUBLIC_BASE_URL }).join()).toContain(
      'must be set together',
    );
  });

  it('refuses a plaintext RPC endpoint, because the provider key rides in it', () => {
    const problems = problemsOf({
      ...WITH_WALLET,
      SOLANA_RPC_URL: 'http://mainnet.helius-rpc.com/?api-key=not-a-real-key',
    });
    expect(problems.join()).toContain('https');
  });

  it('refuses a plaintext signing page, which wallets would refuse anyway', () => {
    const problems = problemsOf({ ...WITH_WALLET, PUBLIC_BASE_URL: 'http://pfp.example.com' });
    expect(problems.join()).toContain('https');
  });

  it('never repeats a rejected value back in the problem it reports', () => {
    const secret = 'https://mainnet.helius-rpc.com/?api-key=super-secret-value';
    const problems = problemsOf({ ...VALID, SOLANA_RPC_URL: secret });

    // The reason names the key, never the value. These strings end up in logs
    // and crash reports, and this one carries a provider credential.
    expect(problems.join()).not.toContain('super-secret-value');
  });
  it('treats a key left blank as absent, not as a malformed value', () => {
    // "PUBLIC_BASE_URL=" in a .env file arrives as an empty string. Reading
    // that as a present-but-broken value refuses to boot over a key somebody
    // deliberately left empty, which is the opposite of what empty means.
    const parsed = parseEnv({ ...VALID, SOLANA_RPC_URL: '', PUBLIC_BASE_URL: '   ' });

    expect(parsed.SOLANA_RPC_URL).toBeUndefined();
    expect(parsed.PUBLIC_BASE_URL).toBeUndefined();
  });

  it('allows http on localhost while developing, where a browser already does', () => {
    // Not a concession. Browsers grant http://localhost a secure context
    // because there is no network path to intercept, and wallet adapters rely
    // on that — without it the signing page could not be developed at all.
    for (const base of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      const parsed = parseEnv({ ...WITH_WALLET, NODE_ENV: 'development', PUBLIC_BASE_URL: base });
      expect(parsed.PUBLIC_BASE_URL).toBe(base);
    }
  });

  it('refuses http on localhost in production, where there is a network path', () => {
    const problems = problemsOf({
      ...WITH_WALLET,
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://localhost:3000',
    });
    expect(problems.join()).toContain('must be https in production');
  });

  it('never exempts the RPC endpoint, which is never local', () => {
    const problems = problemsOf({
      ...WITH_WALLET,
      NODE_ENV: 'development',
      SOLANA_RPC_URL: 'http://localhost:8899',
    });
    expect(problems.join()).toContain('provider key travels inside this URL');
  });
});
