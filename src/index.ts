import { createBot } from './bot/bot.js';
import { createRateLimiter } from './bot/rate-limit.js';
import { createInMemorySessionStore } from './bot/session.js';
import { createRenderCache } from './render/cache.js';
import type { Env } from './config/env.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createPrismaClient } from './db/client.js';
import { createLogger } from './logging/logger.js';

/**
 * Generous enough that no real member notices, tight enough that one client
 * cannot keep the render pipeline saturated once rolling lands.
 */
const ACTIONS_PER_MINUTE = 20;

function loadEnvOrExit(): Env {
  // Fail closed at the very first instruction: a process holding a missing or
  // malformed secret must not reach any handler.
  try {
    return loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`[startup] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnvOrExit();
const logger = createLogger({ level: env.LOG_LEVEL });
const prisma = createPrismaClient(env.DATABASE_URL);
const sessions = createInMemorySessionStore();
const rateLimiter = createRateLimiter({ limit: ACTIONS_PER_MINUTE, windowMs: 60_000 });
const renderCache = createRenderCache();

const bot = createBot({
  token: env.TELEGRAM_BOT_TOKEN,
  prisma,
  sessions,
  rateLimiter,
  renderCache,
  traitRoot: env.TRAIT_ROOT,
  logger,
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // A second Ctrl-C must not start a parallel teardown.
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('shutdown.started', { signal });
  // Stopping the bot first lets the in-flight update finish before the
  // database connection it is using goes away.
  await bot.stop();
  await prisma.$disconnect();
  logger.info('shutdown.complete', { signal });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, (received: NodeJS.Signals) => {
    void shutdown(received);
  });
}

try {
  await bot.start({
    onStart: (info) => {
      logger.info('bot.started', { botId: info.id, nodeEnv: env.NODE_ENV });
    },
  });
} catch (error) {
  // bot.catch only covers errors inside handlers. A failure here means the bot
  // never came up at all — a rejected token, no network — so it is fatal, and
  // it must say so plainly instead of surfacing as an unhandled rejection.
  logger.error('bot.start_failed', {
    reason: error instanceof Error ? error.message : String(error),
  });
  await prisma.$disconnect();
  process.exit(1);
}
