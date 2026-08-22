import { EnvValidationError, loadEnv } from './config/env.js';

// Fail closed at the very first instruction: a process holding a missing or
// malformed secret must not reach any handler.
try {
  const env = loadEnv();
  process.stdout.write(`[startup] environment validated (NODE_ENV=${env.NODE_ENV})\n`);
} catch (error) {
  if (error instanceof EnvValidationError) {
    process.stderr.write(`[startup] ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
