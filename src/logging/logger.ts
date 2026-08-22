import type { LOG_LEVELS } from '../config/env.js';

export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogValue = string | number | boolean | null | undefined;

export interface LogFields {
  readonly [key: string]: LogValue;
}

/**
 * Field names that must never reach a log line. Telegram message text, display
 * names and handles are personal data; a bot token or connection URL is a
 * secret. Redacting by key is a backstop, not a licence — callers should still
 * not pass these. It exists so one careless call site in a later phase cannot
 * turn the log stream into a transcript.
 */
const REDACTED_KEYS = new Set([
  'text',
  'message',
  'caption',
  'username',
  'firstname',
  'lastname',
  'fullname',
  'phone',
  'email',
  'token',
  'databaseurl',
  'url',
  'payload',
]);

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Returns a logger that stamps every line with the given fields. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

function scrub(fields: LogFields): Record<string, LogValue> {
  const safe: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return safe;
}

/** Structured JSON lines: one object per line, machine-readable by default. */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = SEVERITY[options.level];
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const now = options.now ?? ((): Date => new Date());

  const build = (bound: LogFields): Logger => {
    const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
      if (SEVERITY[level] < threshold) {
        return;
      }
      const line = JSON.stringify({
        time: now().toISOString(),
        level,
        event,
        ...scrub(bound),
        ...scrub(fields ?? {}),
      });
      write(line);
    };

    return {
      debug: (event, fields) => {
        emit('debug', event, fields);
      },
      info: (event, fields) => {
        emit('info', event, fields);
      },
      warn: (event, fields) => {
        emit('warn', event, fields);
      },
      error: (event, fields) => {
        emit('error', event, fields);
      },
      child: (fields) => build({ ...bound, ...fields }),
    };
  };

  return build({});
}
