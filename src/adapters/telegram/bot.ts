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
  answer,
  balanceReaderFor,
  checkEligibility,
  countAcceptedThisMonth,
  createInMemoryDraftStore,
  DECLINE_REASONS,
  finish,
  findCommission,
  findCommissionTerms,
  findMemberCommissions,
  findOpenCommission,
  findOperatorQueue,
  joinWaitlist,
  nextMonthStart,
  placeOrder,
  promptFor,
  skip,
  startDraft,
  transitionCommission,
  attachReference,
  createRateLimiter,
  decideEligibility,
  findKnownSince,
  findProjectByGroup,
  parseEligibilityRule,
  recordGroupMembership,
  ruleGroupId,
  verifyHolder,
  addRevision,
  deliverCommission,
  MAX_REVISION,
  saveReference,
} from '../../core/ports.js';
import type {
  Availability,
  MembershipFact,
  ClaimFlowDependencies,
  CommissionDraft,
  CommissionDraftStore,
  CommissionStatus,
  CommissionView,
  CommissionTerms,
  DeclineReason,
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
import { downloadUpload, uploadRejectionReply } from './uploads.js';
import { assertEveryCommandHandled } from './commands.js';
import type { CommandName } from './commands.js';
import {
  commissionStepKeyboard,
  declineReasonKeyboard,
  queueKeyboard,
  revisionKeyboard,
  waitlistKeyboard,
  walletLinkKeyboard,
} from './keyboard.js';
import {
  commissionIntro,
  COMMISSION_NEEDS_PROJECT,
  commissionStatusReply,
  eligibilityReply,
  ORDER_ABANDONED,
  orderPlaced,
  QUEUE_EMPTY,
  QUEUE_NOT_ADMIN,
  QUEUE_PICK_REASON,
  queueActionTaken,
  queueEntry,
  queueMovedOn,
  statusNotification,
  stepPrompt,
  waitlistJoined,
  REFERENCE_SAVED,
  DELIVERY_WANTS_ARTWORK,
  deliveryDone,
  deliveryRefused,
  REVISION_LIMIT_REACHED,
  REVISION_RECORDED,
} from './commission-replies.js';
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
  eligibilityRefusalReply,
  verificationReply,
  VERIFY_NEEDS_USERNAME,
  VERIFY_NO_PROJECT,
  VERIFY_NOT_A_GROUP,
  verifyRateLimited,
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
  /** Where a half-answered questionnaire lives. Defaulted so tests need none. */
  readonly drafts?: CommissionDraftStore;
  /** Throttles /verify per group. Defaulted; injected only by tests. */
  readonly verifyLimiter?: RateLimiter;
  /**
   * Who may work the commission queue, as platform-qualified ids.
   *
   * Defaults to empty, which authorises nobody. An unset allowlist must mean
   * no one can approve, never everyone.
   */
  readonly adminIds?: readonly { readonly platform: string; readonly externalId: string }[];
  /** Needed only to check token holdings; absent means no gate can be checked. */
  readonly solanaRpcUrl?: string | undefined;
  /** Where member uploads and finished commission artwork are written. */
  readonly commissionRoot?: string;
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

  /**
   * Registers a handler for a command the menu declares.
   *
   * The name is typed against COMMANDS, so a handler for a command nobody
   * publishes will not compile — and every registration is recorded, so the
   * assertion below can catch the reverse. Between the two, the menu and the
   * handlers cannot drift apart.
   */
  const registered = new Set<string>();
  const command = (name: CommandName, handler: Parameters<typeof bot.command>[1]): void => {
    registered.add(name);
    bot.command(name, handler);
  };

  /**
   * Verification, throttled per group rather than per person.
   *
   * The command is public and answers about anybody, so the cost of abusing it
   * is spread across a room. Limiting by sender would let ten people in one
   * group take turns hammering it; limiting by group is what actually bounds
   * the work.
   */
  const verifyLimiter = deps.verifyLimiter ?? createRateLimiter({ limit: 10, windowMs: 60_000 });

  const drafts = deps.drafts ?? createInMemoryDraftStore();
  const adminIds = deps.adminIds ?? [];

  /**
   * Which project a member is answering about, and which commission an
   * operator has on screen.
   *
   * Adapter state, like the message bindings: a button press carries no id, so
   * the server has to remember what it last drew. Keeping the operator's
   * position here rather than in the payload is what stops a forged callback
   * addressing somebody else's order.
   */
  const activeDraftProject = new Map<number, number>();
  const queuePosition = new Map<number, number>();

  /**
   * Operators who have said they are about to send finished artwork.
   *
   * A photo is otherwise ambiguous — a member sends one as a reference, an
   * operator sends one as a delivery — and guessing which from who sent it
   * would deliver somebody's reference photo as their commission.
   */
  const awaitingDelivery = new Map<number, number>();

  /**
   * Drafts that are a revision rather than a new order.
   *
   * The questionnaire is identical either way — the plan asks for a revision
   * to be submitted through the same structured form — so what differs is only
   * what happens on confirm, and that is remembered here rather than by
   * teaching the form about it.
   */
  const revisionFor = new Map<number, number>();

  const commissionRoot = deps.commissionRoot ?? deps.claimRoot;

  const isOperator = (telegramUserId: number): boolean =>
    adminIds.some(
      (admin) => admin.platform === 'telegram' && admin.externalId === String(telegramUserId),
    );

  /** Puts the current question on screen and records what it is about. */
  const showStep = async (
    ctx: Context,
    draft: CommissionDraft,
    eligibleSlots: readonly string[],
  ): Promise<void> => {
    activeDraftProject.set(draft.memberId, draft.projectId);
    const prompt = promptFor(draft, eligibleSlots);
    await ctx.reply(stepPrompt(prompt), { reply_markup: commissionStepKeyboard(prompt) });
  };

  /** The draft a member is part-way through, with its project's terms. */
  const activeDraft = async (
    memberId: number,
  ): Promise<{ draft: CommissionDraft; terms: CommissionTerms } | null> => {
    const projectId = activeDraftProject.get(memberId);
    if (projectId === undefined) {
      return null;
    }
    const draft = await drafts.get(memberId, projectId);
    const terms = await findCommissionTerms(prisma, projectId);
    if (draft === undefined || terms === null) {
      return null;
    }
    return { draft, terms };
  };

  /**
   * Tells a member their order moved.
   *
   * Never throws. A notification that cannot be delivered — the member blocked
   * the bot, say — must not roll back a transition that has already happened,
   * because the order really did move and the operator was already told so.
   */
  const notifyMember = async (view: CommissionView): Promise<void> => {
    const member = await prisma.member.findUnique({
      where: { id: view.memberId },
      select: { platform: true, externalId: true },
    });
    if (member === null || member.platform !== 'telegram') {
      return;
    }
    const chatId = Number(member.externalId);
    if (!Number.isFinite(chatId)) {
      return;
    }
    try {
      await bot.api.sendMessage(chatId, statusNotification(view));
    } catch (error) {
      logger.warn('commission.notify_failed', {
        commissionId: view.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Draws the commission an operator is looking at, with its one-tap actions. */
  const showQueueEntry = async (ctx: Context, telegramUserId: number): Promise<void> => {
    const queue = await findOperatorQueue(prisma);
    if (queue.length === 0) {
      queuePosition.delete(telegramUserId);
      await ctx.reply(QUEUE_EMPTY);
      return;
    }

    const current = queuePosition.get(telegramUserId);
    const index = Math.max(
      0,
      queue.findIndex((entry) => entry.id === current),
    );
    const entry = queue[index];
    if (entry === undefined) {
      await ctx.reply(QUEUE_EMPTY);
      return;
    }

    queuePosition.set(telegramUserId, entry.id);
    await ctx.reply(queueEntry(entry, index, queue.length), {
      reply_markup: queueKeyboard(entry.status, queue.length > 1),
    });
  };

  /** Moves the commission on screen, then tells the member. */
  const actOnQueue = async (
    ctx: Context,
    telegramUserId: number,
    to: CommissionStatus,
    declineReason?: DeclineReason,
  ): Promise<void> => {
    const commissionId = queuePosition.get(telegramUserId);
    if (commissionId === undefined) {
      await ctx.reply(QUEUE_EMPTY);
      return;
    }

    const before = await findCommission(prisma, commissionId);
    if (before === null) {
      await ctx.reply(queueMovedOn(null));
      return;
    }

    const moved = await transitionCommission({
      prisma,
      commissionId,
      from: before.status,
      to,
      ...(declineReason === undefined ? {} : { declineReason }),
    });

    if (moved.kind !== 'moved') {
      // Somebody else acted first, or the move was never legal. Either way the
      // operator is told rather than left believing they changed something.
      await ctx.reply(
        moved.kind === 'stale' ? queueMovedOn(moved.actual) : queueMovedOn(before.status),
      );
      await showQueueEntry(ctx, telegramUserId);
      return;
    }

    const after = await findCommission(prisma, commissionId);
    if (after !== null) {
      logger.info('commission.moved', { commissionId, to });
      await ctx.reply(queueActionTaken(after));
      await notifyMember(after);
    }

    // A finished commission leaves the queue, so the operator is moved off it.
    queuePosition.delete(telegramUserId);
    await showQueueEntry(ctx, telegramUserId);
  };

  command('start', async (ctx) => {
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

    // The project's own rule, checked at the first attempt to roll rather than
    // at the claim. Somebody who cannot roll should be told before they pick
    // out a combination they were never going to be allowed to keep.
    //
    // Deliberately after the already-claimed branch above: a member who
    // already holds one must always be able to see it, even if they have since
    // left the group the rule names.
    const eligible = await checkEligibleToRoll(
      outcome.projectId,
      member.id,
      from.id,
      project?.eligibilityRule,
    );

    if (eligible.kind === 'refused') {
      log.info('start.not_eligible', {
        projectId: outcome.projectId,
        reason: eligible.refusal.kind,
      });
      await ctx.reply(eligibilityRefusalReply(eligible.refusal, outcome.projectName));
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
  command('mine', async (ctx) => {
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

  command('wallet', async (ctx) => {
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

  /**
   * Ordering personalised artwork, and checking on one already ordered.
   *
   * One command for both, because a member who has ordered does not want a
   * different verb to ask where theirs is — and an order that goes silent is
   * the failure this whole flow is designed around.
   */
  command('commission', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) {
      return;
    }

    const member = await resolveMember(prisma, telegramIdentity(from));
    const log = logger.child({ memberId: member.id });

    const argument = ctx.match.trim();
    if (argument.length === 0) {
      const held = await findMemberCommissions(prisma, member.id);
      await ctx.reply(
        held.length === 0
          ? COMMISSION_NEEDS_PROJECT
          : commissionStatusReply(held[0] as CommissionView),
      );
      return;
    }

    // Same validation as a deep link payload: attacker-controlled either way.
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

    // An order already in flight is what they came to ask about.
    const open = await findOpenCommission(prisma, project.id, member.id);
    if (open !== null) {
      // A change can be asked for only while there is still something to
      // change, and only if the one allowed revision is unused.
      const revisable =
        (open.status === 'approved' || open.status === 'in_production') &&
        open.briefs.length <= MAX_REVISION;

      await ctx.reply(
        commissionStatusReply(open),
        revisable ? { reply_markup: revisionKeyboard() } : {},
      );
      if (revisable) {
        activeDraftProject.set(member.id, project.id);
      }
      return;
    }

    const terms = await findCommissionTerms(prisma, project.id);
    if (terms === null) {
      await ctx.reply(eligibilityReply({ kind: 'disabled' }, project.name));
      return;
    }

    // A half-answered questionnaire resumes exactly where it stopped, rather
    // than starting them over on questions they have already answered.
    const resumed = await drafts.get(member.id, project.id);
    if (resumed !== undefined) {
      await showStep(ctx, resumed, terms.eligibleSlots);
      return;
    }

    const wallet = await findLinkedWallet(prisma, member.id);
    const outcome = await checkEligibility({
      terms,
      acceptedThisMonth: await countAcceptedThisMonth(prisma, project.id),
      hasOpenOrder: false,
      walletAddress: wallet?.address ?? null,
      now: new Date(),
      ...(deps.solanaRpcUrl === undefined
        ? {}
        : { readBalance: balanceReaderFor(deps.solanaRpcUrl) }),
    });

    if (outcome.kind === 'refused') {
      log.info('commission.refused', { reason: outcome.refusal.kind, projectId: project.id });
      // A full month is the one refusal with something to offer, so it is the
      // one that comes with a button.
      await ctx.reply(
        eligibilityReply(outcome.refusal, project.name),
        outcome.refusal.kind === 'at-capacity' ? { reply_markup: waitlistKeyboard() } : {},
      );
      if (outcome.refusal.kind === 'at-capacity') {
        activeDraftProject.set(member.id, project.id);
      }
      return;
    }

    await ctx.reply(commissionIntro(project.name, terms.priceUsdcCents));
    const draft = startDraft(member.id, project.id);
    await drafts.set(draft);
    await showStep(ctx, draft, terms.eligibleSlots);
  });

  /**
   * The operator queue.
   *
   * Everything here is one tap. Nothing opens a text box, because an operator
   * writing to a member is precisely what this design exists to prevent.
   */
  command('queue', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) {
      return;
    }

    // Fail closed, and before anything is read. An empty allowlist authorises
    // nobody, and the refusal says nothing about what is in the queue.
    if (!isOperator(from.id)) {
      logger.warn('queue.refused', { telegramUserId: from.id });
      await ctx.reply(QUEUE_NOT_ADMIN);
      return;
    }

    queuePosition.delete(from.id);
    await showQueueEntry(ctx, from.id);
  });

  /**
   * Typed answers to the questionnaire.
   *
   * Registered after every command, so a slash command is never swallowed by
   * a half-finished brief. A member with no draft open is not answering
   * anything, and their message is left alone.
   */
  /**
   * Typed answers to the questionnaire.
   *
   * Every path that does not handle the message calls next(), and that is
   * load-bearing rather than tidy: middleware which returns without it ends
   * the chain, so anything registered after this would never run. An earlier
   * version returned bare, and it silently killed /collection — registered
   * below — for an entire phase. The tests did not notice because they
   * exercised the paging functions directly and never sent the command.
   *
   * Passing the message on means registration order stops mattering, which is
   * the only version of this that stays correct as handlers are added.
   */
  bot.on('message:text', async (ctx, next) => {
    const from = ctx.from;
    if (from === undefined || ctx.message.text.startsWith('/')) {
      await next();
      return;
    }

    const member = await resolveMember(prisma, telegramIdentity(from));
    const active = await activeDraft(member.id);
    if (active === null) {
      await next();
      return;
    }

    const { draft, terms } = active;
    // Only two questions take typed input. Anything typed at the others is
    // ignored rather than guessed at.
    if (draft.step !== 'text' && draft.step !== 'note') {
      await next();
      return;
    }

    const result = answer(draft, ctx.message.text, terms.eligibleSlots);
    if (!result.ok) {
      // Corrected at the point of entry, with the question still in front of
      // them, rather than at the end when they have forgotten what they said.
      await ctx.reply(result.problem.message);
      await showStep(ctx, draft, terms.eligibleSlots);
      return;
    }

    await drafts.set(result.draft);
    await showStep(ctx, result.draft, terms.eligibleSlots);
  });

  /**
   * A photo, which is either a member's reference or an operator's delivery.
   *
   * Which one is decided by what the sender was last asked for, never by the
   * photo itself. Nothing about an uploaded file is trusted: the bytes are
   * checked against their own header, the size against what actually arrives,
   * and the stored name is generated rather than taken from anything sent.
   */
  bot.on(['message:photo', 'message:document'], async (ctx, next) => {
    const from = ctx.from;
    if (from === undefined) {
      await next();
      return;
    }

    const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
    const document = ctx.message.document;
    const fileId = photo?.file_id ?? document?.file_id;
    if (fileId === undefined) {
      await next();
      return;
    }

    const member = await resolveMember(prisma, telegramIdentity(from));
    const log = logger.child({ memberId: member.id });

    const deliveringFor = awaitingDelivery.get(from.id);
    const active = deliveringFor === undefined ? await activeDraft(member.id) : null;

    // Nobody asked this sender for a file. Ignored rather than guessed at.
    if (deliveringFor === undefined && active === null) {
      await next();
      return;
    }

    const downloaded = await downloadUpload(ctx, deps.token, fileId);
    if (!downloaded.ok) {
      await ctx.reply(uploadRejectionReply(downloaded.rejection));
      return;
    }

    if (deliveringFor !== undefined) {
      if (!isOperator(from.id)) {
        awaitingDelivery.delete(from.id);
        await ctx.reply(QUEUE_NOT_ADMIN);
        return;
      }

      const commission = await findCommission(prisma, deliveringFor);
      const project =
        commission === null ? null : await findProjectById(prisma, commission.projectId);
      if (commission === null || project === null) {
        awaitingDelivery.delete(from.id);
        await ctx.reply(queueMovedOn(null));
        return;
      }

      const stored = await saveReference(
        commissionRoot,
        commission.projectId,
        commission.memberId,
        downloaded.bytes,
        downloaded.format,
      );

      const pack = await loadPack(roll, commission.projectId);
      const outcome = await deliverCommission({
        prisma,
        commissionId: commission.id,
        projectId: commission.projectId,
        memberId: commission.memberId,
        canvas: pack.canvas,
        sourcePath: stored,
        sourceRoot: commissionRoot,
        claimRoot: deps.claimRoot,
      });

      awaitingDelivery.delete(from.id);

      if (outcome.kind !== 'delivered') {
        await ctx.reply(deliveryRefused(outcome.kind));
        return;
      }

      log.info('commission.delivered', {
        commissionId: commission.id,
        editionNumber: outcome.editionNumber,
      });
      await ctx.reply(deliveryDone(outcome.editionNumber));

      const after = await findCommission(prisma, commission.id);
      if (after !== null) {
        await notifyMember(after);
      }
      return;
    }

    if (active !== null) {
      const stored = await saveReference(
        commissionRoot,
        active.draft.projectId,
        member.id,
        downloaded.bytes,
        downloaded.format,
      );
      // Attaching is not answering: they stay on the question they were on.
      const withReference = attachReference(active.draft, stored);
      await drafts.set(withReference);
      await ctx.reply(REFERENCE_SAVED);
      await showStep(ctx, withReference, active.terms.eligibleSlots);
    }
  });

  /**
   * Whether this member may roll in this project.
   *
   * The rule is the project's; establishing the fact it needs is Telegram's
   * job, and that is the whole split. Anything that is not a definite yes
   * refuses — a gate that opened when getChatMember failed would open exactly
   * when something was wrong.
   */
  const checkEligibleToRoll = async (
    projectId: number,
    memberId: number,
    telegramUserId: number,
    storedRule: unknown,
  ): Promise<ReturnType<typeof decideEligibility>> => {
    const rule = parseEligibilityRule(storedRule);
    const groupId = ruleGroupId(rule);

    // Nothing to ask about. Decided without a round trip.
    if (rule !== null && groupId === null) {
      return decideEligibility(rule, { kind: 'unknown' }, new Date());
    }

    let fact: MembershipFact = { kind: 'unknown' };

    if (groupId !== null) {
      const chatId = Number(groupId);
      if (!Number.isSafeInteger(chatId)) {
        // A rule naming a group this front end cannot address is a rule it
        // cannot enforce, and an unenforceable gate must not be an open one.
        logger.warn('eligibility.group_not_telegram', { projectId });
      } else {
        try {
          const status = (await bot.api.getChatMember(chatId, telegramUserId)).status;
          const present =
            status === 'creator' ||
            status === 'administrator' ||
            status === 'member' ||
            status === 'restricted';

          if (present) {
            // Recorded on the way past, which is what gives tenure anything
            // to measure. Set once; never moved forward.
            const knownSince = await recordGroupMembership(prisma, projectId, memberId);
            fact = { kind: 'member', knownSince };
          } else {
            fact = { kind: 'not-member' };
          }
        } catch (error) {
          // The bot is not in the group, or Telegram is unhappy. Either way
          // this is "could not check", which refuses.
          logger.warn('eligibility.check_failed', {
            projectId,
            reason: error instanceof Error ? error.message : String(error),
          });
          fact = { kind: 'unknown' };
        }
      }
    }

    // A member already recorded keeps their tenure even if this particular
    // check could not confirm them again.
    if (fact.kind === 'member' && fact.knownSince === null) {
      fact = { kind: 'member', knownSince: await findKnownSince(prisma, projectId, memberId) };
    }

    return decideEligibility(rule, fact, new Date());
  };

  /**
   * Says publicly what somebody holds.
   *
   * Runs in a project's group, where the answer is meant to be readable by
   * everybody — that is the point of it. It reads no wallet address, and the
   * lookup does not select one, so there is nothing here to leak.
   *
   * Entirely independent of channel gating: a project with no channel
   * configured verifies exactly the same way.
   */
  command('verify', async (ctx) => {
    const from = ctx.from;
    const chat = ctx.chat;
    if (from === undefined || chat === undefined) {
      return;
    }

    // Group only. In a private chat there is no project bound to the room and
    // no community to read the answer.
    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      await ctx.reply(VERIFY_NOT_A_GROUP);
      return;
    }

    const decision = verifyLimiter.check(String(chat.id));
    if (!decision.allowed) {
      logger.info('verify.rate_limited', { chatId: chat.id });
      await ctx.reply(verifyRateLimited(decision.retryAfterSeconds));
      return;
    }

    const project = await findProjectByGroup(prisma, String(chat.id));
    if (project === null) {
      await ctx.reply(VERIFY_NO_PROJECT);
      return;
    }

    const handle = normaliseUsername(ctx.match.trim().replace(/^@/, ''));
    if (handle === null) {
      await ctx.reply(VERIFY_NEEDS_USERNAME);
      return;
    }

    const outcome = await verifyHolder(prisma, project.id, 'telegram', handle);
    logger.info('verify.answered', { projectId: project.id, outcome: outcome.kind });

    await ctx.reply(verificationReply(outcome, project.name));
  });

  /** Every claim the member holds, across every collection. */
  command('collection', async (ctx) => {
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

    // Commission and queue buttons belong to messages with no roll behind
    // them, so they are handled before any session lookup — exactly as
    // collection paging and wallet linking are.
    const commissionAction = parseCallbackData(ctx.callbackQuery.data, 0);

    if (commissionAction !== null && commissionAction.kind.startsWith('queue-')) {
      // Authorisation comes from the sender, never from the payload. A forged
      // queue button from a non-operator is refused here.
      if (!isOperator(from.id)) {
        logger.warn('queue.callback_refused', { telegramUserId: from.id });
        await ctx.reply(QUEUE_NOT_ADMIN);
        return;
      }

      switch (commissionAction.kind) {
        case 'queue-deliver': {
          const commissionId = queuePosition.get(from.id);
          if (commissionId === undefined) {
            await ctx.reply(QUEUE_EMPTY);
            return;
          }
          // Recorded so the next photo from this operator is read as a
          // delivery rather than as somebody's reference image.
          awaitingDelivery.set(from.id, commissionId);
          await ctx.reply(DELIVERY_WANTS_ARTWORK);
          return;
        }

        case 'queue-paid':
          await actOnQueue(ctx, from.id, 'awaiting_approval');
          return;

        case 'queue-approve':
          await actOnQueue(ctx, from.id, 'approved');
          return;

        case 'queue-produce':
          await actOnQueue(ctx, from.id, 'in_production');
          return;

        case 'queue-decline':
          // A reason is always chosen, never typed, and never skipped: the
          // member's explanation is generated from it.
          await ctx.reply(QUEUE_PICK_REASON, { reply_markup: declineReasonKeyboard() });
          return;

        case 'queue-reason': {
          const reason = DECLINE_REASONS[commissionAction.position];
          if (reason === undefined) {
            log.warn('queue.reason_off_list');
            return;
          }
          await actOnQueue(ctx, from.id, 'declined', reason);
          return;
        }

        case 'queue-next': {
          const queue = await findOperatorQueue(prisma);
          const current = queuePosition.get(from.id);
          const index = queue.findIndex((entry) => entry.id === current);
          // Wraps rather than stopping: an operator reaching the end should
          // come back round, not find a button that does nothing.
          const next = queue[(index + 1) % Math.max(1, queue.length)];
          if (next !== undefined) {
            queuePosition.set(from.id, next.id);
          }
          await showQueueEntry(ctx, from.id);
          return;
        }

        case 'queue-back':
          await showQueueEntry(ctx, from.id);
          return;

        default:
          return;
      }
    }

    if (commissionAction !== null && commissionAction.kind.startsWith('commission-')) {
      const active = await activeDraft(member.id);

      if (commissionAction.kind === 'commission-waitlist') {
        const projectId = activeDraftProject.get(member.id);
        if (projectId === undefined) {
          await ctx.reply(COMMISSION_NEEDS_PROJECT);
          return;
        }
        await joinWaitlist(prisma, projectId, member.id);
        log.info('commission.waitlisted', { projectId });
        await ctx.reply(waitlistJoined(nextMonthStart(new Date())));
        return;
      }

      if (commissionAction.kind === 'commission-revise') {
        const projectId = activeDraftProject.get(member.id);
        if (projectId === undefined) {
          await ctx.reply(COMMISSION_NEEDS_PROJECT);
          return;
        }
        const open = await findOpenCommission(prisma, projectId, member.id);
        const terms = await findCommissionTerms(prisma, projectId);
        if (open === null || terms === null) {
          await ctx.reply(COMMISSION_NEEDS_PROJECT);
          return;
        }
        if (open.briefs.length > MAX_REVISION) {
          await ctx.reply(REVISION_LIMIT_REACHED);
          return;
        }

        // The same form as the original, as the plan asks.
        revisionFor.set(member.id, open.id);
        const fresh = startDraft(member.id, projectId);
        await drafts.set(fresh);
        await showStep(ctx, fresh, terms.eligibleSlots);
        return;
      }

      if (active === null) {
        // Their answers expired or were cleared. Nothing is lost that was
        // ever ordered, so this is a restart rather than an error.
        await ctx.reply(COMMISSION_NEEDS_PROJECT);
        return;
      }

      const { draft, terms } = active;

      switch (commissionAction.kind) {
        case 'commission-abandon':
          await drafts.clear(member.id, draft.projectId);
          activeDraftProject.delete(member.id);
          revisionFor.delete(member.id);
          await ctx.reply(ORDER_ABANDONED);
          return;

        case 'commission-skip': {
          const skipped = skip(draft);
          if (!skipped.ok) {
            await ctx.reply(skipped.problem.message);
            await showStep(ctx, draft, terms.eligibleSlots);
            return;
          }
          await drafts.set(skipped.draft);
          await showStep(ctx, skipped.draft, terms.eligibleSlots);
          return;
        }

        case 'commission-slot':
        case 'commission-colour': {
          // A position into the list the server itself drew. Resolving it here
          // is what keeps slot names and colour values out of the payload.
          const prompt = promptFor(draft, terms.eligibleSlots);
          const options = prompt.step === 'slot' || prompt.step === 'colour' ? prompt.options : [];
          const chosen = options[commissionAction.position];

          if (chosen === undefined) {
            log.warn('commission.option_off_list');
            return;
          }

          const answered = answer(draft, chosen, terms.eligibleSlots);
          if (!answered.ok) {
            await ctx.reply(answered.problem.message);
            await showStep(ctx, draft, terms.eligibleSlots);
            return;
          }
          await drafts.set(answered.draft);
          await showStep(ctx, answered.draft, terms.eligibleSlots);
          return;
        }

        case 'commission-order': {
          // Re-validated against the project's current terms, because the
          // eligible slots can change while somebody is answering.
          const finished = finish(draft, terms.eligibleSlots);
          if (!finished.ok) {
            await ctx.reply(finished.problems.map((problem) => problem.message).join('\n'));
            return;
          }

          // A revision replaces the brief on an order that already exists,
          // rather than creating a second one.
          const revising = revisionFor.get(member.id);
          if (revising !== undefined) {
            const recorded = await addRevision(prisma, revising, finished.brief);
            await drafts.clear(member.id, draft.projectId);
            activeDraftProject.delete(member.id);
            revisionFor.delete(member.id);

            await ctx.reply(
              recorded.kind === 'recorded' ? REVISION_RECORDED : REVISION_LIMIT_REACHED,
            );
            if (recorded.kind === 'recorded') {
              log.info('commission.revised', { commissionId: revising });
            }
            return;
          }

          const placed = await placeOrder({
            prisma,
            projectId: draft.projectId,
            memberId: member.id,
            brief: finished.brief,
            priceUsdcCents: terms.priceUsdcCents,
            treasuryShareBps: terms.treasuryShareBps,
            monthlyCapacity: terms.monthlyCapacity,
          });

          if (placed.kind === 'ordered') {
            await drafts.clear(member.id, draft.projectId);
            activeDraftProject.delete(member.id);
            log.info('commission.ordered', { commissionId: placed.commissionId });
            await ctx.reply(orderPlaced(terms.priceUsdcCents));
            return;
          }

          // The month filled, or they already have one, while they answered.
          // Their answers are kept either way — nothing they typed is lost.
          const refusal =
            placed.kind === 'already-ordered'
              ? ({ kind: 'already-ordered' } as const)
              : ({
                  kind: 'at-capacity',
                  capacity: terms.monthlyCapacity,
                  reopensAt: nextMonthStart(new Date()),
                } as const);

          const project = await findProjectById(prisma, draft.projectId);
          await ctx.reply(
            eligibilityReply(refusal, project?.name ?? 'this collection'),
            placed.kind === 'at-capacity' ? { reply_markup: waitlistKeyboard() } : {},
          );
          return;
        }

        default:
          return;
      }
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

  // Checked before the bot is handed back, so a command published into
  // everybody's menu with nothing behind it cannot start.
  assertEveryCommandHandled(registered);

  return bot;
}
