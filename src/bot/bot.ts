import { Bot, GrammyError, HttpError } from 'grammy';
import type { Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { resolveMember } from '../db/member-repository.js';
import {
  findClaimForMember,
  findProjectById,
  findProjectBySlug,
} from '../db/project-repository.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { RenderCache } from '../render/cache.js';
import { TraitImageError } from '../render/errors.js';
import type { Logger } from '../logging/logger.js';
import { parseCallbackData } from './callback-data.js';
import { resolveEntry } from './entry.js';
import { normaliseUsername, parseStartPayload } from './payload.js';
import {
  CLAIM_NOT_ENABLED,
  entryReply,
  GENERIC_ERROR,
  rateLimitReply,
  ROLL_EXHAUSTED,
  ROLL_RENDER_FAILED,
  ROLL_SLOT_STUCK,
  ROLL_STALE,
  ROLL_UNDETERMINED,
} from './replies.js';
import type { RateLimiter } from './rate-limit.js';
import { loadPack, presentFreshRoll, presentSlotCycle } from './roll.js';
import type { RollDependencies } from './roll.js';
import type { SessionStore } from './session.js';

export interface BotDependencies {
  readonly token: string;
  readonly prisma: PrismaClient;
  readonly sessions: SessionStore;
  readonly rateLimiter: RateLimiter;
  readonly renderCache: RenderCache;
  readonly traitRoot: string;
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

  const roll: RollDependencies = {
    prisma,
    sessions,
    renderCache: deps.renderCache,
    traitRoot: deps.traitRoot,
    logger,
  };

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
      // A throttled button press still gets answered, or the client spins.
      if (ctx.callbackQuery !== undefined) {
        await ctx.answerCallbackQuery({ text: rateLimitReply(decision.retryAfterSeconds) });
        return;
      }
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

    if (outcome.kind !== 'ready') {
      await ctx.reply(entryReply(outcome));
      return;
    }

    // Entering fresh discards an abandoned roll, so a member never resumes
    // half-way through a session they walked away from.
    await sessions.clear(member.id, outcome.projectId);

    const pack = await loadPack(roll, outcome.projectId);
    const session = {
      memberId: member.id,
      projectId: outcome.projectId,
      traitIds: [],
      messageId: null,
      updatedAt: Date.now(),
    };

    const presentation = await presentFreshRoll(ctx, roll, session, pack);
    if (presentation.kind === 'exhausted') {
      await ctx.reply(ROLL_EXHAUSTED);
    } else if (presentation.kind === 'undetermined') {
      await ctx.reply(ROLL_UNDETERMINED);
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    const from = ctx.from;
    const messageId = ctx.callbackQuery.message?.message_id;

    // Answered first, always, so the client stops spinning before any work
    // begins. Telegram gives this a few seconds and no more.
    await ctx.answerCallbackQuery();

    if (messageId === undefined) {
      return;
    }

    const member = await resolveMember(prisma, BigInt(from.id), normaliseUsername(from.username));
    const log = logger.child({ memberId: member.id });

    // The session is found from the message, never from the callback payload.
    const session = await sessions.findByMessage(member.id, messageId);
    if (session === undefined) {
      log.info('callback.no_session');
      await ctx.reply(ROLL_STALE);
      return;
    }

    // Re-checked on every press: a drop can close mid-session, and rolling on
    // after it does would be the check failing open.
    const project = await findProjectById(prisma, session.projectId);
    const gate = resolveEntry({ project, existingClaim: null, now: new Date() });
    if (gate.kind !== 'ready') {
      log.info('callback.gate_refused', { outcome: gate.kind });
      await sessions.clear(session.memberId, session.projectId);
      await ctx.reply(entryReply(gate));
      return;
    }

    const pack = await loadPack(roll, session.projectId);
    const action = parseCallbackData(ctx.callbackQuery.data, pack.slots.length);

    if (action === null) {
      log.warn('callback.rejected');
      return;
    }

    try {
      if (action.kind === 'claim') {
        await ctx.reply(CLAIM_NOT_ENABLED);
        return;
      }

      if (action.kind === 'reroll') {
        const presentation = await presentFreshRoll(ctx, roll, session, pack);
        if (presentation.kind === 'exhausted') {
          await ctx.reply(ROLL_EXHAUSTED);
        } else if (presentation.kind === 'undetermined') {
          await ctx.reply(ROLL_UNDETERMINED);
        }
        return;
      }

      const result = await presentSlotCycle(ctx, roll, session, pack, action.slotIndex);
      if (result === 'stale') {
        await sessions.clear(session.memberId, session.projectId);
        await ctx.reply(ROLL_STALE);
      } else if (result === 'unchanged') {
        await ctx.reply(ROLL_SLOT_STUCK);
      }
    } catch (error) {
      // A broken trait image is an operator problem, not a member's. It gets a
      // named log line and the member gets a reply they can act on, rather
      // than the generic apology from the global handler.
      if (!(error instanceof TraitImageError)) {
        throw error;
      }
      log.error('roll.render_failed', {
        projectId: session.projectId,
        imagePath: error.imagePath,
      });
      await ctx.reply(ROLL_RENDER_FAILED);
    }
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
