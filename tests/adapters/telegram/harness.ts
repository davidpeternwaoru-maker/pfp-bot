import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot } from '../../../src/adapters/telegram/bot.js';
import { createRateLimiter } from '../../../src/core/rate-limit.js';
import { createInMemorySessionStore } from '../../../src/core/session.js';
import { createInMemoryMessageBindings } from '../../../src/adapters/telegram/message-binding.js';
import type { MessageBindingStore } from '../../../src/adapters/telegram/message-binding.js';
import type { RateLimiter } from '../../../src/core/rate-limit.js';
import type { RollSessionStore } from '../../../src/core/session.js';
import type { EntryExistingClaim, EntryProject } from '../../../src/core/entry.js';
import { createRenderCache } from '../../../src/core/render/cache.js';
import { createAvailability } from '../../../src/core/roll/availability.js';
import type { RenderCache } from '../../../src/core/render/cache.js';
import type { CanvasSize, ExclusionPair, TraitRecord } from '../../../src/core/render/types.js';
import { createLogger } from '../../../src/logging/logger.js';
import type { PrismaClient } from '../../../src/generated/prisma/client.js';
import { makeTempRoot, solidPng } from '../../helpers/fixtures.js';

/**
 * Drives the real bot with synthetic updates.
 *
 * Nothing is stubbed except the two edges — Telegram and Postgres — so the
 * middleware, the command handler, the payload parser, the entry resolver, the
 * pool draw and the renderer under test are the ones that run in production.
 */

export const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Test Bot',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export interface FakeDatabase {
  readonly projectsBySlug: ReadonlyMap<string, EntryProject>;
  readonly claimsByProjectAndMember: ReadonlyMap<string, EntryExistingClaim>;
  /** Combination hashes already claimed, keyed by project id. */
  readonly claimedHashes?: ReadonlyMap<number, readonly string[]>;
  readonly canvas?: CanvasSize;
  readonly traits?: readonly TraitRecord[];
  readonly exclusions?: readonly ExclusionPair[];
}

/**
 * A stand-in for the queries the handlers make. Built as a plain object and
 * cast once, rather than reaching for `any` at each call site.
 */
export function fakePrisma(db: FakeDatabase): PrismaClient {
  const byId = new Map<number, EntryProject>();
  for (const project of db.projectsBySlug.values()) {
    byId.set(project.id, project);
  }

  const stub = {
    member: {
      upsert: (args: { where: { platform_externalId: { externalId: string } } }) =>
        Promise.resolve({ id: Number(args.where.platform_externalId.externalId) }),
    },
    project: {
      findUnique: (args: { where: { slug?: string; id?: number } }) => {
        const found =
          args.where.slug !== undefined
            ? db.projectsBySlug.get(args.where.slug)
            : args.where.id !== undefined
              ? byId.get(args.where.id)
              : undefined;
        if (found === undefined) {
          return Promise.resolve(null);
        }
        const canvas = db.canvas ?? { width: 32, height: 32 };
        return Promise.resolve({
          ...found,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
        });
      },
    },
    trait: {
      findMany: () => Promise.resolve(db.traits ?? []),
    },
    exclusion: {
      findMany: () => Promise.resolve(db.exclusions ?? []),
    },
    claim: {
      // Reads through the scoped index, matching the real one-claim-per-slot
      // lookup rather than the blanket one it replaced. The fixture is keyed
      // by member, so the slot key is split back apart here.
      findUnique: (args: {
        where: { projectId_memberSlotKey: { projectId: number; memberSlotKey: string } };
      }) => {
        const { projectId, memberSlotKey } = args.where.projectId_memberSlotKey;
        const memberId = memberSlotKey.split(':')[0] ?? '';
        return Promise.resolve(
          db.claimsByProjectAndMember.get(`${String(projectId)}:${memberId}`) ?? null,
        );
      },
      findMany: (args: {
        where: { projectId?: number; memberId?: number; claimType?: string };
      }) => {
        // Two different callers land here: the claimed-hash scan for a
        // project, and the per-member lookups behind /mine and /collection.
        if (args.where.memberId !== undefined) {
          return Promise.resolve([]);
        }
        const projectId = args.where.projectId ?? 0;
        return Promise.resolve(
          (db.claimedHashes?.get(projectId) ?? []).map((combinationHash) => ({
            combinationHash,
          })),
        );
      },
    },
  };

  return stub as unknown as PrismaClient;
}

export interface ApiCall {
  readonly method: string;
  readonly text: string | undefined;
  readonly messageId: number | undefined;
  /** Button rows, flattened to their callback data. Empty when there are none. */
  readonly buttons: readonly string[];
}

export interface Harness {
  readonly bot: Bot;
  readonly sessions: RollSessionStore;
  readonly bindings: MessageBindingStore;
  /** Every text the bot sent, whether as a message or a callback answer. */
  readonly sent: string[];
  /** Every outbound API call, in order. */
  readonly calls: ApiCall[];
  countOf(method: string): number;
  send(text: string, userId?: number): Promise<void>;
  press(data: string, messageId: number, userId?: number): Promise<void>;
}

export interface HarnessOptions {
  readonly db?: FakeDatabase;
  readonly rateLimiter?: RateLimiter;
  readonly renderCache?: RenderCache;
  readonly traitRoot?: string;
  readonly claimRoot?: string;
}

const EMPTY_DB: FakeDatabase = {
  projectsBySlug: new Map(),
  claimsByProjectAndMember: new Map(),
};

/**
 * Writes a real trait pack to disk. The renderer validates magic bytes and
 * dimensions, so these have to be genuine PNGs of the right size.
 */
export interface TraitFixtures {
  readonly root: string;
  readonly canvas: CanvasSize;
  readonly traits: readonly TraitRecord[];
  cleanup(): Promise<void>;
}

export async function createTraitFixtures(
  layout: readonly {
    readonly slot: string;
    readonly layerOrder: number;
    readonly options: number;
  }[],
  canvas: CanvasSize = { width: 32, height: 32 },
): Promise<TraitFixtures> {
  const root = await makeTempRoot();
  const traits: TraitRecord[] = [];
  let nextId = 1;

  for (const entry of layout) {
    await mkdir(join(root, entry.slot), { recursive: true });
    for (let index = 0; index < entry.options; index += 1) {
      const name = `option-${String(index + 1)}`;
      const imagePath = `${entry.slot}/${name}.png`;
      await writeFile(
        join(root, imagePath),
        await solidPng(canvas.width, canvas.height, {
          r: (index * 40) % 256,
          g: (entry.layerOrder * 20) % 256,
          b: 128,
          a: 255,
        }),
      );
      traits.push({
        id: nextId++,
        slot: entry.slot,
        name,
        layerOrder: entry.layerOrder,
        imagePath,
        rarityWeight: 1,
        tier: 'open',
      });
    }
  }

  return {
    root,
    canvas,
    traits,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const sent: string[] = [];
  const calls: ApiCall[] = [];
  const sessions = createInMemorySessionStore();
  const bindings = createInMemoryMessageBindings();
  let nextMessageId = 1000;

  const prisma = fakePrisma(options.db ?? EMPTY_DB);

  const bot = createBot({
    token: '123456789:AAHtesttesttesttesttesttesttesttest1',
    prisma,
    sessions,
    bindings,
    rateLimiter: options.rateLimiter ?? createRateLimiter({ limit: 1000, windowMs: 60_000 }),
    renderCache: options.renderCache ?? createRenderCache(),
    // Zero-lived, so every assertion sees the fixture's claimed set as it is
    // now rather than as it was at the top of the test.
    availability: createAvailability(prisma, { maxAgeMs: 0 }),
    traitRoot: options.traitRoot ?? '.',
    claimRoot: options.claimRoot ?? '.',
    // Silenced: these tests assert on replies, not on log output.
    logger: createLogger({ level: 'error', write: () => undefined }),
    botInfo: BOT_INFO,
  });

  // Intercept outbound API calls instead of letting them reach Telegram.
  bot.api.config.use((_prev, method, payload) => {
    // editMessageMedia nests its caption inside `media`; everything else is
    // flat. Reading only the flat one would make a final claim caption
    // invisible to every assertion.
    const media = 'media' in payload ? (payload.media as { caption?: unknown }) : undefined;
    const nestedCaption = typeof media?.caption === 'string' ? media.caption : undefined;
    const text =
      'text' in payload && typeof payload.text === 'string'
        ? payload.text
        : 'caption' in payload && typeof payload.caption === 'string'
          ? payload.caption
          : nestedCaption;

    const messageId =
      'message_id' in payload && typeof payload.message_id === 'number'
        ? payload.message_id
        : undefined;

    const markup =
      'reply_markup' in payload
        ? (payload.reply_markup as { inline_keyboard?: { callback_data?: unknown }[][] })
        : undefined;
    const buttons = (markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => (typeof button.callback_data === 'string' ? button.callback_data : ''))
      .filter((data) => data.length > 0);

    calls.push({ method, text, messageId, buttons });
    if (text !== undefined) {
      sent.push(text);
    }

    if (method === 'sendPhoto' || method === 'sendMessage') {
      nextMessageId += 1;
      return Promise.resolve({
        ok: true,
        result: { message_id: nextMessageId },
      } as never);
    }

    return Promise.resolve({ ok: true, result: true } as never);
  });

  let updateId = 0;

  return {
    bot,
    sessions,
    bindings,
    sent,
    calls,
    countOf(method: string): number {
      return calls.filter((call) => call.method === method).length;
    },
    async send(text: string, userId = 555): Promise<void> {
      updateId += 1;
      const update: Update = {
        update_id: updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: userId, type: 'private', first_name: 'Tester' },
          from: { id: userId, is_bot: false, first_name: 'Tester', username: 'tester' },
          text,
          entities: text.startsWith('/start')
            ? [{ type: 'bot_command', offset: 0, length: 6 }]
            : [],
        },
      };
      await bot.handleUpdate(update);
    },
    async press(data: string, messageId: number, userId = 555): Promise<void> {
      updateId += 1;
      const update: Update = {
        update_id: updateId,
        callback_query: {
          id: String(updateId),
          from: { id: userId, is_bot: false, first_name: 'Tester', username: 'tester' },
          chat_instance: 'test',
          data,
          message: {
            message_id: messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: userId, type: 'private', first_name: 'Tester' },
          },
        },
      };
      await bot.handleUpdate(update);
    },
  };
}

export function project(overrides: Partial<EntryProject> & { id: number }): EntryProject {
  return {
    name: `Project ${String(overrides.id)}`,
    status: 'live',
    claimOpensAt: null,
    claimClosesAt: null,
    ...overrides,
  };
}
