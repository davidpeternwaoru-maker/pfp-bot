import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

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

export const envSchema = z.object({
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
});

export type Env = z.infer<typeof envSchema>;

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
