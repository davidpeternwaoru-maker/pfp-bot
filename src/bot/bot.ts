import { Bot, GrammyError, HttpError } from 'grammy';
import type { Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { resolveMember } from '../db/member-repository.js';
import { findClaimForMember, findProjectBySlug } from '../db/project-repository.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Logger } from '../logging/logger.js';
import { resolveEntry } from './entry.js';
import { normaliseUsername, parseStartPayload } from './payload.js';
import { entryReply, GENERIC_ERROR, rateLimitReply } from './replies.js';
import type { RateLimiter } from './rate-limit.js';
import type { SessionStore } from './session.js';

export interface BotDependencies {
  readonly token: string;
  readonly prisma: PrismaClient;
  readonly sessions: SessionStore;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  /**
   * Supplying the bot's own identity skips the getMe call grammY would
   * otherwise make on start, which is what lets the handlers be driven with
   * synthetic updates in a test with no network.
   */
  readonly botInfo?: UserFromGetMe;
}

export function createBot(deps: BotDependencies): Bot {
  const { prisma, sessions, rateLimiter, logger } = deps;
  const bot = new Bot(deps.token, deps.botInfo === undefined ? {} : { botInfo: deps.botInfo });

  // Rate limiting sits in front of every handler rather than on the expensive
  // ones individually, so a handler added in a later phase is covered without
  // anyone remembering to opt in.
  bot.use(async (ctx: Context, next) => {
    const userId = ctx.from?.id;

    // Fail closed: an update with no identifiable sender cannot be throttled,
    // so it is not served.
    if (userId === undefined) {
      logger.warn('update.no_sender');
      return;
    }

    const decision = rateLimiter.check(String(userId));
    if (!decision.allowed) {
      logger.info('rate_limit.blocked', { telegramUserId: userId });
      await ctx.reply(rateLimitReply(decision.retryAfterSeconds));
      return;
    }

    await next();
  });

  bot.command('start', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) {
      return;
    }

    const payload = parseStartPayload(ctx.match.length > 0 ? ctx.match : undefined);

    // The member row is created even for a bad link: knowing someone arrived is
    // useful, and it costs one upsert. The payload itself is never stored.
    const member = await resolveMember(prisma, BigInt(from.id), normaliseUsername(from.username));

    const log = logger.child({ memberId: member.id });

    if (!payload.ok) {
      log.info('start.payload_rejected', { reason: payload.reason });
      await ctx.reply(entryReply({ kind: 'unknown-project' }));
      return;
    }

    const project = await findProjectBySlug(prisma, payload.slug);
    const existingClaim =
      project === null ? null : await findClaimForMember(prisma, project.id, member.id);

    const outcome = resolveEntry({ project, existingClaim, now: new Date() });
    log.info('start.resolved', { outcome: outcome.kind, projectId: project?.id ?? null });

    if (outcome.kind === 'ready') {
      // Entering fresh discards an abandoned roll, so a member never resumes
      // half-way through a session they walked away from.
      await sessions.clear(member.id, outcome.projectId);
    }

    await ctx.reply(entryReply(outcome));
  });

  bot.catch((error) => {
    const { ctx } = error;

    // Errors are classified so an operator can tell a Telegram outage from a
    // bug in our own code without reading a stack trace out of a chat log.
    const kind =
      error.error instanceof GrammyError
        ? 'telegram_api'
        : error.error instanceof HttpError
          ? 'network'
          : 'unhandled';

    logger.error('handler.failed', {
      kind,
      updateId: ctx.update.update_id,
      telegramUserId: ctx.from?.id ?? null,
      // Message only — a stack trace can carry file paths and internals, and
      // this line may end up somewhere less trusted than this process.
      reason: error.error instanceof Error ? error.error.message : String(error.error),
    });

    // Best effort: if the apology itself cannot be delivered there is nothing
    // further to do, and throwing here would take the process down.
    void ctx.reply(GENERIC_ERROR).catch(() => {
      logger.warn('handler.apology_undeliverable', { updateId: ctx.update.update_id });
    });
  });

  return bot;
}
