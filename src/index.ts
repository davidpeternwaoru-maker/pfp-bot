import { createBot } from './adapters/telegram/bot.js';
import { createHttpServer } from './adapters/http/server.js';
import { createRateLimiter } from './core/rate-limit.js';
import { createInMemorySessionStore } from './core/session.js';
import { createRenderCache } from './core/render/cache.js';
import { createAvailability } from './core/roll/availability.js';
import type { Env } from './config/env.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createPrismaClient } from './core/db/client.js';
import { createLogger } from './logging/logger.js';
import { createShutdown } from './shutdown.js';

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
// Answers what a caption says about a combination being free. Never what a
// claim is allowed to do: that is a unique index, and it is not cached.
const availability = createAvailability(prisma);

const bot = createBot({
  token: env.TELEGRAM_BOT_TOKEN,
  prisma,
  sessions,
  rateLimiter,
  renderCache,
  availability,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  traitRoot: env.TRAIT_ROOT,
  claimRoot: env.CLAIM_ROOT,
  logger,
});

/**
 * The signing page, started only when wallet features are configured.
 *
 * No listener at all is the right answer for a project that does not use
 * wallets: an open port serving a page nobody can complete is a surface with
 * no purpose.
 */
const httpServer =
  env.PUBLIC_BASE_URL === undefined
    ? undefined
    : createHttpServer({ prisma, logger, publicBaseUrl: env.PUBLIC_BASE_URL });

if (httpServer !== undefined) {
  httpServer.listen(env.HTTP_PORT, () => {
    logger.info('http.listening', { port: env.HTTP_PORT });
  });
}

const shutdown = createShutdown({
  stopBot: () => bot.stop(),
  stopHttp:
    httpServer === undefined
      ? undefined
      : () =>
          new Promise<void>((resolve) => {
            httpServer.close(() => {
              resolve();
            });
          }),
  disconnectDatabase: () => prisma.$disconnect(),
  logger,
});

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
