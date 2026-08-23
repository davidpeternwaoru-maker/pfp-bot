import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Platform } from '../generated/prisma/enums.js';

/**
 * Startup environment validation.
 *
 * The process must refuse to start when a required variable is missing or
 * malformed. There are deliberately no defaults: a default for a secret is a
 * silent downgrade to a wrong-but-running system.
 */

const POSTGRES_URL_PREFIXES = ['postgres://', 'postgresql://'] as const;

// Telegram issues tokens as <bot id>:<secret>. Checking the shape at startup
// turns a truncated or quote-wrapped paste into a boot failure rather than a
// confusing 401 on the first API call.
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,16}:[A-Za-z0-9_-]{30,}$/;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  // Not a secret, so a default is safe here — unlike DATABASE_URL or the bot
  // token, where falling back would mean running against the wrong thing.
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => POSTGRES_URL_PREFIXES.some((prefix) => value.startsWith(prefix)),
      'must be a postgres:// or postgresql:// connection URL',
    ),
  TELEGRAM_BOT_TOKEN: z
    .string()
    .regex(TELEGRAM_BOT_TOKEN_PATTERN, 'must have the shape <bot id>:<secret>'),
  // Every trait image must resolve inside this directory; loadTraitImage
  // refuses anything that escapes it, symlinks included.
  TRAIT_ROOT: z.string().min(1).default('trait-packs'),
  // Where claimed artwork is written. The database is the record of a claim;
  // these files are a reproducible cache, since the render is deterministic.
  CLAIM_ROOT: z.string().min(1).default('output/claims'),
  /**
   * Telegram user ids permitted to award legendaries, comma separated.
   * Defaults to empty, which authorises nobody: an unset allowlist must mean
   * no one can award, never everyone.
   */
  /**
   * Who may issue an award, as "platform:id" entries — e.g.
   * "telegram:8853090779,discord:4711".
   *
   * The platform is required rather than assumed: an operator's Telegram id
   * and their Discord id are different numbers, and silently treating a bare
   * number as Telegram would eventually authorise the wrong person.
   */
  /**
   * Solana JSON-RPC endpoint, including any provider key it carries.
   *
   * One variable holding the whole URL rather than a provider name plus a key:
   * changing provider is then a config change instead of a code change, and
   * there is exactly one string to keep out of logs rather than two.
   *
   * https only. A provider key travels inside this URL, so plain http would
   * put it on the wire in clear text for anyone on the path.
   *
   * Optional, and that is deliberate. Wallet linking gates token features and
   * nothing else — ordinary claiming must work with no wallet and no RPC
   * configured at all, so an unset endpoint disables those features rather
   * than refusing to boot.
   */
  SOLANA_RPC_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), 'must be https, never http')
    .optional(),
  /**
   * Where members reach this process from a browser, e.g.
   * https://pfp.example.com. Used to build the signing page link.
   *
   * https for the same reason every wallet adapter insists on it: a signing
   * page served over http can be rewritten in transit, and what it would be
   * rewritten to is a request to sign something else.
   */
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), 'must be https, never http')
    .optional(),
  /** Port the signing page and health checks are served on. */
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  ADMIN_IDS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(
      z.array(
        z
          .string()
          .regex(
            /^(telegram|discord|web):[A-Za-z0-9_-]{1,64}$/,
            'must be "platform:id", e.g. telegram:8853090779',
          ),
      ),
    )
    .transform((entries) =>
      entries.map((entry) => {
        const [platform, externalId] = entry.split(':');
        return { platform: platform as Platform, externalId: externalId ?? '' };
      }),
    ),
});

/**
 * Wallet configuration is both halves or neither.
 *
 * An RPC endpoint with nowhere to host the signing page, or a signing page
 * with nothing to verify balances against, is a half-built feature. Caught at
 * startup, it is one line an operator fixes before anyone sees it; caught at
 * run time, it is a member part-way through linking a wallet when the flow
 * discovers it cannot finish.
 */
export const envSchema = baseEnvSchema.refine(
  (env) => (env.SOLANA_RPC_URL === undefined) === (env.PUBLIC_BASE_URL === undefined),
  {
    message:
      'SOLANA_RPC_URL and PUBLIC_BASE_URL must be set together — ' +
      'wallet linking needs both, and neither is any use alone. ' +
      'Leave both unset to run without wallet features.',
    path: ['SOLANA_RPC_URL'],
  },
);

export type Env = z.infer<typeof envSchema>;

/**
 * Whether wallet features are configured at all.
 *
 * Wallet linking gates token features and nothing else, so this being false is
 * an ordinary state and not a degraded one: claiming must work with no wallet
 * and no RPC endpoint anywhere in the environment.
 */
export function walletFeaturesEnabled(env: Env): boolean {
  return env.SOLANA_RPC_URL !== undefined && env.PUBLIC_BASE_URL !== undefined;
}

/** Carries which keys are wrong and why — never what their values were. */
export class EnvValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvValidationError';
    this.problems = problems;
  }
}

/** Pure: validates a plain record so tests never have to mutate process.env. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return result.data;
  }

  // Reason strings only. The offending values are secrets and must not reach
  // logs, error trackers, or a crash report.
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${key}: ${issue.message}`;
  });

  throw new EnvValidationError(problems);
}

let cached: Env | undefined;

/**
 * Reads and validates the real environment. Side-effecting on purpose, and the
 * only place in the codebase that touches process.env.
 */
export function loadEnv(): Env {
  if (cached !== undefined) {
    return cached;
  }

  // A .env file is a local development convenience. Production is expected to
  // inject real variables, so we never let a stray file override them there.
  const envFile = resolve(process.cwd(), '.env');
  if (process.env['NODE_ENV'] !== 'production' && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }

  cached = parseEnv(process.env);
  return cached;
}
