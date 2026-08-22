import { MAX_SLUG_LENGTH } from '../bot/payload.js';
import { CliError } from './errors.js';

/**
 * Flag parsing and validation.
 *
 * Everything here is pure and throws CliError, so every command can validate
 * its whole input before it opens a database connection. A command that
 * half-validates is a command that can fail after it has already written.
 */

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly flags: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

export function parseArgv(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith('--')) {
      command ??= token;
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }

    const next = argv[i + 1];
    // A flag followed by another flag, or by nothing, is a switch. This is why
    // `--yes` and `--project x` can share one syntax without ambiguity.
    if (next === undefined || next.startsWith('--')) {
      switches.add(body);
      continue;
    }

    flags.set(body, next);
    i += 1;
  }

  return { command, flags, switches };
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined || value.length === 0) {
    throw new CliError(`missing --${name}`);
  }
  return value;
}

export function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return value === undefined || value.length === 0 ? undefined : value;
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * The same rule the deep link parser enforces. A slug the CLI accepts but the
 * bot rejects would create a project nobody can ever open.
 */
export function requireSlug(args: ParsedArgs, name: string): string {
  const raw = requireFlag(args, name);
  if (raw.length > MAX_SLUG_LENGTH) {
    throw new CliError(`--${name} must be ${String(MAX_SLUG_LENGTH)} characters or fewer`);
  }
  if (!SLUG_PATTERN.test(raw)) {
    throw new CliError(`--${name} may contain only lowercase letters, digits and hyphens`);
  }
  return raw;
}

export interface IntRange {
  readonly min?: number;
  readonly max?: number;
}

export function requireInt(args: ParsedArgs, name: string, range: IntRange = {}): number {
  const raw = requireFlag(args, name);
  const value = Number(raw);

  if (!Number.isSafeInteger(value)) {
    throw new CliError(`--${name} must be a whole number`);
  }
  if (range.min !== undefined && value < range.min) {
    throw new CliError(`--${name} must be at least ${String(range.min)}`);
  }
  if (range.max !== undefined && value > range.max) {
    throw new CliError(`--${name} must be at most ${String(range.max)}`);
  }
  return value;
}

/** A comma-separated id list, e.g. --traits 12,19,27. */
export function requireIdList(args: ParsedArgs, name: string): number[] {
  const raw = requireFlag(args, name);
  const parts = raw.split(',').map((part) => part.trim());
  const ids: number[] = [];

  for (const part of parts) {
    const value = Number(part);
    if (part.length === 0 || !Number.isSafeInteger(value) || value <= 0) {
      throw new CliError(`--${name} must be positive whole numbers separated by commas`);
    }
    ids.push(value);
  }

  if (new Set(ids).size !== ids.length) {
    throw new CliError(`--${name} contains the same id twice`);
  }
  return ids;
}

export function optionalDate(args: ParsedArgs, name: string): Date | undefined {
  const raw = optionalFlag(args, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new CliError(`--${name} must be an ISO 8601 timestamp, e.g. 2026-09-01T12:00:00Z`);
  }
  return value;
}

/** Telegram user id, either bare or as @handle for the award target. */
export function requireTelegramId(args: ParsedArgs, name: string): bigint {
  const raw = requireFlag(args, name);
  if (!/^\d{1,19}$/.test(raw)) {
    throw new CliError(`--${name} must be a numeric Telegram user id`);
  }
  return BigInt(raw);
}
