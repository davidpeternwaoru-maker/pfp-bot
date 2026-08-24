import {
  TraitImageError,
  attemptClaim,
  collectionPage,
  currentCombination,
  findAnnounceSettings,
  findClaimForMember,
  findCollection,
  findMemberClaims,
  findProjectById,
  findLinkedWallet,
  findProjectBySlug,
  loadClaimArtwork,
  guardClaim,
  issueChallenge,
  loadPack,
  openBrowse,
  presentHeld,
  resolveEntry,
  resolveMember,
  rollFresh,
  rollPickOption,
  rollSlotCycle,
  unlinkWallet,
  CHALLENGE_TTL_MS,
} from '../../core/ports.js';
import type {
  Availability,
  ClaimFlowDependencies,
  MemberIdentity,
  RateLimiter,
  RenderCache,
  RollDependencies,
  RollSessionStore,
} from '../../core/ports.js';
import { Bot, GrammyError, HttpError, InputFile } from 'grammy';
import type { Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Logger } from '../../logging/logger.js';
import { parseCallbackData, parseCollectionPage, WALLET_LINK } from './callback-data.js';
import { collectionKeyboard, formatCollectionPage } from './collection.js';
import { normaliseUsername, parseStartPayload } from './payload.js';
import {
  announceClaim,
  cancelConfirmation,
  promptConfirmation,
  showClaimed,
} from './claim-flow.js';
import { showBrowse, showCombination } from './presenter.js';
import { walletLinkKeyboard } from './keyboard.js';
import { createInMemoryMessageBindings } from './message-binding.js';
import type { MessageBindingStore } from './message-binding.js';
import {
  CLAIM_CANCELLED,
  CLAIM_COMBINATION_INVALID,
  CLAIM_NEEDS_PROJECT,
  CLAIM_NONE_YET,
  CLAIM_RACE_LOST,
  collisionReply,
  entryReply,
  existingClaimReply,
  GENERIC_ERROR,
  rateLimitReply,
  ROLL_EXHAUSTED,
  ROLL_RENDER_FAILED,
  ROLL_SLOT_STUCK,
  ROLL_STALE,
  ROLL_UNDETERMINED,
  WALLET_DISABLED,
  WALLET_NONE_LINKED,
  WALLET_NOTHING_TO_UNLINK,
  WALLET_UNLINKED,
  walletLinkPrompt,
  walletLinked,
  walletRateLimited,
} from './replies.js';

/** Telegram's identity for a sender, in the shape core understands. */
function telegramIdentity(from: { id: number; username?: string | undefined }): MemberIdentity {
  return {
    platform: 'telegram',
    externalId: String(from.id),
    handle: normaliseUsername(from.username),
  };
}

export interface BotDependencies {
  readonly token: string;
  readonly prisma: PrismaClient;
  readonly sessions: RollSessionStore;
  /** Optional so tests and scripts can inspect the binding store. */
  readonly bindings?: MessageBindingStore;
  readonly rateLimiter: RateLimiter;
  readonly renderCache: RenderCache;
  readonly availability: Availability;
  /**
   * Where the signing page is served from, or undefined when wallet features
   * are switched off. Undefined is an ordinary state, not a degraded one:
   * claiming has never needed a wallet and still does not.
   */
  readonly publicBaseUrl?: string | undefined;
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
    availability: deps.availability,
    traitRoot: deps.traitRoot,
    logger,
  };

  const claimFlow: ClaimFlowDependencies = { ...roll, claimRoot: deps.claimRoot };

  // Which message is showing which roll. Telegram's business, not core's.
  const bindings = deps.bindings ?? createInMemoryMessageBindings();
  const presenter = { bindings, logger };

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
    const member = await resolveMember(prisma, telegramIdentity(from));

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

    // A fresh entry starts a new message, so any previous binding is dropped.
    await bindings.release(member.id, outcome.projectId);

    const pack = await loadPack(roll, outcome.projectId);
    const result = await rollFresh(roll, pack, member.id);

    if (result.kind === 'exhausted') {
      await ctx.reply(ROLL_EXHAUSTED);
      return;
    }
    if (result.kind === 'undetermined') {
      await ctx.reply(ROLL_UNDETERMINED);
      return;
    }

    await showCombination(ctx, presenter, pack, member.id, result.combination);
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

    const member = await resolveMember(prisma, telegramIdentity(from));
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

  /**
   * Linking a wallet, checking one, and removing one.
   *
   * Entirely optional, and it gates token features only. Nothing in the claim
   * path consults this, and nothing here is ever required to roll or claim.
   */
  /**
   * Issues a challenge and sends the signing link.
   *
   * Shared by the /wallet link command and the button beside "no wallet
   * linked", so the two cannot drift into offering different flows.
   */
  const startWalletLink = async (ctx: Context, memberId: number, log: Logger): Promise<void> => {
    // Checked here rather than at startup: a bot running without wallet
    // features is the ordinary case, and it must answer rather than look broken.
    if (deps.publicBaseUrl === undefined) {
      await ctx.reply(WALLET_DISABLED);
      return;
    }

    const issued = await issueChallenge({ prisma, memberId });
    if (issued.kind === 'rate-limited') {
      log.info('wallet.link_rate_limited');
      await ctx.reply(walletRateLimited(issued.retryAfterSeconds));
      return;
    }

    // The URL carries a one-time opaque token and nothing else. A member id
    // here would identify a person to anyone who saw the link.
    const url = new URL(`/link/${issued.challenge.token}`, deps.publicBaseUrl).toString();
    log.info('wallet.link_started');

    // link_preview_options off: a preview would send the one-time token to
    // Telegram's fetcher, spending a single-use link before the member opens it.
    await ctx.reply(walletLinkPrompt(url, Math.round(CHALLENGE_TTL_MS / 60_000)), {
      link_preview_options: { is_disabled: true },
    });
  };

  bot.command('wallet', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) {
      return;
    }

    const member = await resolveMember(prisma, telegramIdentity(from));
    const log = logger.child({ memberId: member.id });
    const action = ctx.match.trim().toLowerCase();

    if (action === 'unlink') {
      const removed = await unlinkWallet(prisma, member.id);
      log.info('wallet.unlink', { removed });
      await ctx.reply(removed ? WALLET_UNLINKED : WALLET_NOTHING_TO_UNLINK);
      return;
    }

    if (action !== 'link') {
      const linked = await findLinkedWallet(prisma, member.id);
      if (linked !== null) {
        await ctx.reply(walletLinked(linked.address, linked.linkedAt));
        return;
      }
      // A button, not an instruction to type a second command. Telling
      // somebody to send /wallet link is homework, and every other dead end in
      // this product answers with something tappable.
      //
      // No button when linking is switched off: offering one that can only
      // reply "not switched on" would be a dead end wearing a button.
      await ctx.reply(
        WALLET_NONE_LINKED,
        deps.publicBaseUrl === undefined ? {} : { reply_markup: walletLinkKeyboard() },
      );
      return;
    }

    await startWalletLink(ctx, member.id, log);
  });

  /** Every claim the member holds, across every collection. */
  bot.command('collection', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) {
      return;
    }

    const member = await resolveMember(prisma, telegramIdentity(from));
    const entries = await findCollection(prisma, member.id);
    const page = collectionPage(entries, 0);
    const keyboard = collectionKeyboard(page);

    await ctx.reply(
      formatCollectionPage(page),
      keyboard === undefined ? {} : { reply_markup: keyboard },
    );
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

    const member = await resolveMember(prisma, telegramIdentity(from));
    const log = logger.child({ memberId: member.id });

    // Collection paging belongs to a message with no roll behind it, so it is
    // handled before any session lookup. The member id comes from the sender,
    // never from the payload, so nobody can page through someone else's
    // collection.
    const requestedPage = parseCollectionPage(ctx.callbackQuery.data);
    if (requestedPage !== null) {
      const entries = await findCollection(prisma, member.id);
      const page = collectionPage(entries, requestedPage);
      const keyboard = collectionKeyboard(page);
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) {
        await ctx.api.editMessageText(
          chatId,
          messageId,
          formatCollectionPage(page),
          keyboard === undefined ? {} : { reply_markup: keyboard },
        );
      }
      return;
    }

    // Linking belongs to a message with no roll behind it, so it is handled
    // before any session lookup. Who is asking comes from the sender, never
    // from the payload, so nobody can start a link for somebody else.
    if (ctx.callbackQuery.data === WALLET_LINK) {
      await startWalletLink(ctx, member.id, log);
      return;
    }

    // The message identifies which project is on screen, and core holds what
    // the member is looking at. Neither comes from the callback payload, which
    // is attacker-controlled.
    const boundProjectId = await bindings.findProject(member.id, messageId);
    const session =
      boundProjectId === undefined ? undefined : await sessions.get(member.id, boundProjectId);

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
      const result = await rollFresh(roll, pack, session.memberId);
      if (result.kind === 'exhausted') {
        await ctx.reply(ROLL_EXHAUSTED);
        return;
      }
      if (result.kind === 'undetermined') {
        await ctx.reply(ROLL_UNDETERMINED);
        return;
      }
      await showCombination(ctx, presenter, pack, session.memberId, result.combination);
    };

    /** What the member is currently holding, or null if the pack moved on. */
    const held = currentCombination(pack, session.traitIds);

    /**
     * Puts the artwork back on screen, closing any open slot list.
     *
     * Re-presented rather than restored from the previous caption, so leaving a
     * list refreshes whether the combination is still free. A member can spend
     * a while reading option names, and the answer can change while they do.
     */
    const backToArtwork = async (): Promise<void> => {
      if (held === null) {
        await sessions.clear(session.memberId, session.projectId);
        await ctx.reply(ROLL_STALE);
        return;
      }
      const combination = await presentHeld(roll, pack, session.memberId, held);
      await showCombination(ctx, presenter, pack, session.memberId, combination);
    };

    try {
      switch (action.kind) {
        case 'claim': {
          if (held === null) {
            await sessions.clear(session.memberId, session.projectId);
            await ctx.reply(ROLL_STALE);
            return;
          }

          // Refused before the confirmation rather than after it. Browsing lets
          // a member assemble a combination somebody already holds on purpose,
          // and walking them through "claim this permanently?" only to refuse
          // would look like a product that had not been paying attention.
          const guard = await guardClaim(roll, pack, held);
          if (guard.advice !== null) {
            log.info('claim.already_held', { projectId: session.projectId });
            await backToArtwork();
            await ctx.reply(collisionReply(guard.advice));
            return;
          }

          // Never claims on the first press. A permanent, one-per-collection
          // decision does not happen on a single tap.
          if ((await promptConfirmation(ctx, bindings, session.memberId, pack, held)) === 'stale') {
            await sessions.clear(session.memberId, session.projectId);
            await ctx.reply(ROLL_STALE);
          }
          return;
        }

        case 'cancel-claim': {
          if (
            held === null ||
            (await cancelConfirmation(ctx, bindings, session.memberId, pack, held)) === 'stale'
          ) {
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

          const result = await attemptClaim(claimFlow, pack, session.memberId, session.traitIds);

          switch (result.kind) {
            case 'claimed': {
              await showClaimed(
                ctx,
                bindings,
                session.memberId,
                pack,
                settings.name,
                result.claim,
                result.traits,
              );

              if (settings.announceOnClaim && settings.announceChannelId !== null) {
                await announceClaim(
                  ctx.api,
                  logger,
                  settings.announceChannelId,
                  settings.name,
                  result.claim.editionNumber,
                  result.traits,
                  normaliseUsername(from.username),
                );
              }
              return;
            }

            case 'race-lost': {
              log.info('claim.race_lost', { projectId: session.projectId });

              // The guard above said this was free, so it went in the seconds
              // between. Whether that reads as a race or as a wall depends on
              // what is left around it, so ask before choosing the words: if a
              // single slot change frees it, keeping them where they are and
              // naming that change respects the combination they built. If
              // nothing does, a fresh roll is the only useful answer.
              deps.availability.invalidate(session.projectId);
              const guard = held === null ? null : await guardClaim(roll, pack, held);

              if (guard?.advice != null && !guard.advice.stuck) {
                await backToArtwork();
                await ctx.reply(collisionReply(guard.advice));
                return;
              }

              // Losing a race is not the member's fault and costs them nothing:
              // apologise and put a free combination in front of them at once.
              await ctx.reply(CLAIM_RACE_LOST);
              await freshRoll();
              return;
            }

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
          const result = await rollSlotCycle(
            roll,
            pack,
            session.memberId,
            session.traitIds,
            action.slotIndex,
          );

          if (result.kind === 'stale') {
            await sessions.clear(session.memberId, session.projectId);
            await ctx.reply(ROLL_STALE);
          } else if (result.kind === 'unchanged') {
            await ctx.reply(ROLL_SLOT_STUCK);
          } else {
            await showCombination(ctx, presenter, pack, session.memberId, result.combination);
          }
          return;
        }

        case 'open-browse':
        case 'browse-page': {
          // Opening names the slot; paging does not, because the member is
          // already inside one. Reading it back from the session is what keeps
          // the page button down to a page number.
          const slotIndex =
            action.kind === 'open-browse' ? action.slotIndex : session.browse?.slotIndex;

          // A page press with no open list means the session was replaced
          // under them. Nothing is lost, so put the artwork back rather than
          // reporting an error for a button that was valid a moment ago.
          if (slotIndex === undefined) {
            await backToArtwork();
            return;
          }

          const opened = await openBrowse(
            roll,
            pack,
            session.memberId,
            session.traitIds,
            slotIndex,
            action.kind === 'browse-page' ? action.pageIndex : 0,
          );

          if (
            opened.kind === 'stale' ||
            (await showBrowse(ctx, presenter, session.projectId, session.memberId, opened.view)) ===
              'stale'
          ) {
            await sessions.clear(session.memberId, session.projectId);
            await ctx.reply(ROLL_STALE);
          }
          return;
        }

        case 'pick-option': {
          const browse = session.browse;
          if (browse === null) {
            log.info('callback.pick_without_browse');
            await ctx.reply(ROLL_STALE);
            return;
          }

          const result = await rollPickOption(
            roll,
            pack,
            session.memberId,
            session.traitIds,
            browse,
            action.positionOnPage,
          );

          if (result.kind === 'rolled') {
            await showCombination(ctx, presenter, pack, session.memberId, result.combination);
            return;
          }

          if (result.kind === 'unchanged') {
            // The position was not on the page they have open. The callback is
            // already answered and their list is still on screen, so the
            // honest response is to leave both alone.
            log.warn('callback.option_off_page');
            return;
          }

          await sessions.clear(session.memberId, session.projectId);
          await ctx.reply(ROLL_STALE);
          return;
        }

        case 'close-browse':
          await backToArtwork();
          return;
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
