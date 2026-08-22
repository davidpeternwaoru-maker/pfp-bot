import { GrammyError, InputFile } from 'grammy';
import type { Context } from 'grammy';
import { loadClaimedHashes } from '../db/claim-repository.js';
import { fetchTraitPack } from '../db/trait-pack-repository.js';
import { renderCacheKey } from '../render/cache.js';
import type { RenderCache } from '../render/cache.js';
import { combinationHash } from '../render/hash.js';
import { renderCombination } from '../render/image.js';
import type { TraitPack, TraitRecord } from '../render/types.js';
import { drawUnclaimed } from '../roll/pool.js';
import { cycleSlot, resolveCombination } from '../roll/cycle.js';
import type { Logger } from '../logging/logger.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { rollKeyboard } from './keyboard.js';
import { rollCaption, ROLL_EXHAUSTED, ROLL_UNDETERMINED } from './replies.js';
import type { SessionState, SessionStore } from './session.js';

export interface RollDependencies {
  readonly prisma: PrismaClient;
  readonly sessions: SessionStore;
  readonly renderCache: RenderCache;
  readonly traitRoot: string;
  readonly logger: Logger;
}

export type RollPresentation =
  { readonly kind: 'shown' } | { readonly kind: 'exhausted' } | { readonly kind: 'undetermined' };

/**
 * Renders a combination, using the cache when the same one has been seen
 * recently. Rerolling back and forth is normal, and re-encoding an identical
 * PNG for it is pure waste.
 */
async function renderCached(
  deps: RollDependencies,
  pack: TraitPack,
  traits: readonly TraitRecord[],
): Promise<Buffer> {
  const hash = combinationHash(traits.map((trait) => trait.id));
  const key = renderCacheKey(pack.projectId, hash);

  const cached = deps.renderCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const image = await renderCombination(traits, {
    canvas: pack.canvas,
    root: deps.traitRoot,
  });
  deps.renderCache.set(key, image);
  return image;
}

/**
 * Puts the combination on screen and records it in the session.
 *
 * The first call sends a photo; every later one edits that same message. One
 * message per member per session is the whole point — a chat that fills with a
 * new image per button press is unusable on a phone.
 */
async function show(
  ctx: Context,
  deps: RollDependencies,
  session: SessionState,
  pack: TraitPack,
  traits: readonly TraitRecord[],
): Promise<void> {
  const image = await renderCached(deps, pack, traits);
  const traitIds = traits.map((trait) => trait.id);
  const caption = rollCaption(traits);
  const keyboard = rollKeyboard(pack);

  if (session.messageId === null) {
    const sent = await ctx.replyWithPhoto(new InputFile(image, 'roll.png'), {
      caption,
      reply_markup: keyboard,
    });
    await deps.sessions.set({
      memberId: session.memberId,
      projectId: session.projectId,
      traitIds,
      messageId: sent.message_id,
    });
    return;
  }

  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    return;
  }

  try {
    await ctx.api.editMessageMedia(
      chatId,
      session.messageId,
      { type: 'photo', media: new InputFile(image, 'roll.png'), caption },
      { reply_markup: keyboard },
    );
    await deps.sessions.set({
      memberId: session.memberId,
      projectId: session.projectId,
      traitIds,
      messageId: session.messageId,
    });
  } catch (error) {
    // The message may have been deleted by the member. Recovering with a fresh
    // one keeps them rolling; failing here would strand them with dead buttons.
    if (!(error instanceof GrammyError)) {
      throw error;
    }
    deps.logger.info('roll.edit_failed', {
      memberId: session.memberId,
      projectId: session.projectId,
      reason: error.description,
    });
    const sent = await ctx.replyWithPhoto(new InputFile(image, 'roll.png'), {
      caption,
      reply_markup: keyboard,
    });
    await deps.sessions.set({
      memberId: session.memberId,
      projectId: session.projectId,
      traitIds,
      messageId: sent.message_id,
    });
  }
}

/** Draws a combination nobody holds and shows it. */
export async function presentFreshRoll(
  ctx: Context,
  deps: RollDependencies,
  session: SessionState,
  pack: TraitPack,
): Promise<RollPresentation> {
  const claimed = await loadClaimedHashes(deps.prisma, pack.projectId);
  const outcome = drawUnclaimed({ pack, isClaimed: (hash) => claimed.has(hash) });

  if (outcome.kind === 'exhausted') {
    deps.logger.info('roll.pool_exhausted', { projectId: pack.projectId });
    return { kind: 'exhausted' };
  }

  if (outcome.kind === 'undetermined') {
    deps.logger.warn('roll.draw_undetermined', {
      projectId: pack.projectId,
      examined: outcome.examined,
    });
    return { kind: 'undetermined' };
  }

  await show(ctx, deps, session, pack, outcome.traits);
  return { kind: 'shown' };
}

/** Cycles one slot, holding the rest of the combination fixed. */
export async function presentSlotCycle(
  ctx: Context,
  deps: RollDependencies,
  session: SessionState,
  pack: TraitPack,
  slotIndex: number,
): Promise<'shown' | 'unchanged' | 'stale'> {
  const current = resolveCombination(pack, session.traitIds);
  if (current === null) {
    return 'stale';
  }

  const cycled = cycleSlot(pack, current, slotIndex);
  if (cycled === null) {
    return 'stale';
  }

  if (!cycled.changed) {
    return 'unchanged';
  }

  await show(ctx, deps, session, pack, cycled.traits);
  return 'shown';
}

export async function loadPack(deps: RollDependencies, projectId: number): Promise<TraitPack> {
  return fetchTraitPack(deps.prisma, projectId);
}

export { ROLL_EXHAUSTED, ROLL_UNDETERMINED };
