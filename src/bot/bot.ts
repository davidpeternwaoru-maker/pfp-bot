import { Bot, GrammyError, HttpError, InputFile } from 'grammy';
import type { Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { resolveMember } from '../db/member-repository.js';
import {
  findAnnounceSettings,
  findClaimForMember,
  findProjectById,
  findProjectBySlug,
} from '../db/project-repository.js';
import { findCollection, findMemberClaims } from '../db/claim-repository.js';
import { loadClaimArtwork } from '../claim/artwork.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { RenderCache } from '../render/cache.js';
import { TraitImageError } from '../render/errors.js';
import type { Logger } from '../logging/logger.js';
import { parseCallbackData, parseCollectionPage } from './callback-data.js';
import { collectionKeyboard, renderCollectionPage } from './collection.js';
import { resolveEntry } from './entry.js';
import { normaliseUsername, parseStartPayload } from './payload.js';
import { cancelConfirmation, performClaim, promptConfirmation } from './claim-flow.js';
import type { ClaimFlowDependencies } from './claim-flow.js';
import {
  CLAIM_CANCELLED,
  CLAIM_COMBINATION_INVALID,
  CLAIM_NEEDS_PROJECT,
  CLAIM_NONE_YET,
  CLAIM_RACE_LOST,
  entryReply,
  existingClaimReply,
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
  readonly claimRoot: string;
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

  const claimFlow: ClaimFlowDependencies = { ...roll, claimRoot: deps.claimRoot };

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

  /**
   * Returns the claim a member already holds, with the full-resolution file.
   *
   * The slug is required rather than inferred: a successful claim clears the
   * session, so there is usually nothing left to infer from, and guessing the
   * wrong collection would show someone the wrong artwork.
   */
  bot.command('mine', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) {
      return;
    }

    const member = await resolveMember(prisma, BigInt(from.id), normaliseUsername(from.username));
    const log = logger.child({ memberId: member.id });

    const argument = ctx.match.trim();
    if (argument.length === 0) {
      await ctx.reply(CLAIM_NEEDS_PROJECT);
      return;
    }

    // Same validation as a deep link payload: this is attacker-controlled too.
    const payload = parseStartPayload(argument);
    if (!payload.ok) {
      await ctx.reply(entryReply({ kind: 'unknown-project' }));
      return;
    }

    const project = await findProjectBySlug(prisma, payload.slug);
    if (project === null) {
      await ctx.reply(entryReply({ kind: 'unknown-project' }));
      return;
    }

    const claims = await findMemberClaims(prisma, project.id, member.id);
    if (claims.length === 0) {
      await ctx.reply(CLAIM_NONE_YET);
      return;
    }

    const pack = await loadPack(roll, project.id);

    // A member can hold their open claim plus any awarded ones, so each is
    // sent as its own file rather than picking one and hiding the rest.
    for (const claim of claims) {
      const artwork = await loadClaimArtwork(
        deps.claimRoot,
        deps.traitRoot,
        claim.imagePath,
        pack,
        claim.traitIds,
      );

      const caption = existingClaimReply(
        claim.projectName,
        claim.editionNumber,
        claim.claimedAt,
        claim.tier,
      );

      if (artwork === null) {
        // The row is the record of the claim, so it is still reported even
        // when the artwork cannot be produced.
        log.error('claim.artwork_unavailable', {
          projectId: project.id,
          editionNumber: claim.editionNumber,
        });
        await ctx.reply(caption);
        continue;
      }

      // Sent as a document, not a photo: Telegram re-compresses photos, and
      // the point of this command is the original file.
      await ctx.replyWithDocument(
        new InputFile(artwork, `edition-${String(claim.editionNumber)}.png`),
        { caption },
      );
    }
  });

  /** Every claim the member holds, across every collection. */
  bot.command('collection', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) {
      return;
    }

    const member = await resolveMember(prisma, BigInt(from.id), normaliseUsername(from.username));
    const entries = await findCollection(prisma, member.id);
    const page = renderCollectionPage(entries, 0);
    const keyboard = collectionKeyboard(page);

    await ctx.reply(page.text, keyboard === undefined ? {} : { reply_markup: keyboard });
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

    // Collection paging belongs to a message with no roll behind it, so it is
    // handled before any session lookup. The member id comes from the sender,
    // never from the payload, so nobody can page through someone else's
    // collection.
    const requestedPage = parseCollectionPage(ctx.callbackQuery.data);
    if (requestedPage !== null) {
      const entries = await findCollection(prisma, member.id);
      const page = renderCollectionPage(entries, requestedPage);
      const keyboard = collectionKeyboard(page);
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) {
        await ctx.api.editMessageText(
          chatId,
          messageId,
          page.text,
          keyboard === undefined ? {} : { reply_markup: keyboard },
        );
      }
      return;
    }

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

    const freshRoll = async (): Promise<void> => {
      const presentation = await presentFreshRoll(ctx, roll, session, pack);
      if (presentation.kind === 'exhausted') {
        await ctx.reply(ROLL_EXHAUSTED);
      } else if (presentation.kind === 'undetermined') {
        await ctx.reply(ROLL_UNDETERMINED);
      }
    };

    try {
      switch (action.kind) {
        case 'claim': {
          // Never claims on the first press. A permanent, one-per-collection
          // decision does not happen on a single tap.
          if ((await promptConfirmation(ctx, session, pack)) === 'stale') {
            await sessions.clear(session.memberId, session.projectId);
            await ctx.reply(ROLL_STALE);
          }
          return;
        }

        case 'cancel-claim': {
          if ((await cancelConfirmation(ctx, session, pack)) === 'stale') {
            await sessions.clear(session.memberId, session.projectId);
            await ctx.reply(ROLL_STALE);
          } else {
            await ctx.reply(CLAIM_CANCELLED);
          }
          return;
        }

        case 'confirm-claim': {
          const settings = await findAnnounceSettings(prisma, session.projectId);
          if (settings === null) {
            await ctx.reply(GENERIC_ERROR);
            return;
          }

          const result = await performClaim(ctx, claimFlow, session, pack, {
            projectName: settings.name,
            announceOnClaim: settings.announceOnClaim,
            telegramGroupId: settings.telegramGroupId,
            claimantUsername: normaliseUsername(from.username),
          });

          switch (result.kind) {
            case 'claimed':
              return;

            case 'race-lost':
              // Losing a race is not the member's fault and costs them nothing:
              // apologise and put a free combination in front of them at once.
              log.info('claim.race_lost', { projectId: session.projectId });
              await ctx.reply(CLAIM_RACE_LOST);
              await freshRoll();
              return;

            case 'invalid':
              await ctx.reply(CLAIM_COMBINATION_INVALID);
              await freshRoll();
              return;

            case 'already-claimed':
              await sessions.clear(session.memberId, session.projectId);
              await ctx.reply(
                entryReply({
                  kind: 'already-claimed',
                  projectName: settings.name,
                  editionNumber: result.editionNumber,
                }),
              );
              return;

            case 'closed':
              await sessions.clear(session.memberId, session.projectId);
              await ctx.reply(entryReply({ kind: 'window-closed', projectName: settings.name }));
              return;

            case 'stale':
              await sessions.clear(session.memberId, session.projectId);
              await ctx.reply(ROLL_STALE);
              return;
          }
          return;
        }

        case 'reroll':
          await freshRoll();
          return;

        case 'cycle-slot': {
          const result = await presentSlotCycle(ctx, roll, session, pack, action.slotIndex);
          if (result === 'stale') {
            await sessions.clear(session.memberId, session.projectId);
            await ctx.reply(ROLL_STALE);
          } else if (result === 'unchanged') {
            await ctx.reply(ROLL_SLOT_STUCK);
          }
          return;
        }
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
