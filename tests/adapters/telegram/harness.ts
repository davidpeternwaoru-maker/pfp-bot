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
  /** Wallets already linked, keyed by member id. */
  readonly wallets?: ReadonlyMap<
    number,
    { walletAddress: string | null; walletLinkedAt: Date | null }
  >;
  /**
   * Which project a group chat belongs to, if any.
   *
   * Explicitly nullable so a test can pass undefined to mean "this group is
   * bound to nothing", which is a case worth covering rather than one to be
   * expressed by leaving the key out of a spread.
   */
  readonly groupBinding?:
    | {
        readonly groupId: string;
        readonly projectId: number;
        readonly name: string;
      }
    | undefined;
  /** The stored eligibility rule, as it would come out of the JSON column. */
  readonly eligibilityRule?: unknown;
  /** What tenure is measured from. Defaults to now, i.e. no tenure yet. */
  readonly knownSince?: Date;
  /** Claims to report for /verify, keyed by member id. */
  readonly claimsByMember?: ReadonlyMap<
    number,
    readonly { editionNumber: number; tier: string; claimedAt: Date }[]
  >;
  /** Commission terms, keyed by project id. Absent means none are sold. */
  readonly commissionTerms?: ReadonlyMap<number, FakeCommissionTerms>;
  /** Commissions already accepted this month, keyed by project id. */
  readonly commissionsThisMonth?: ReadonlyMap<number, number>;
}

export interface FakeCommissionTerms {
  readonly enabled: boolean;
  readonly priceUsdcCents: number;
  readonly treasuryShareBps: number;
  readonly monthlyCapacity: number;
  readonly eligibleSlots: readonly string[];
  readonly tokenMint: string | null;
  readonly tokenMinimum: string | null;
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

  // Wallet state the /wallet command reads and writes. Held here rather than
  // in FakeDatabase because these tests mutate it as they go.
  const wallets = new Map<number, { walletAddress: string | null; walletLinkedAt: Date | null }>(
    [...(db.wallets ?? new Map())].map(([memberId, entry]) => [memberId, { ...entry }]),
  );
  const challenges: { memberId: number; createdAt: Date }[] = [];

  /**
   * Commissions this run has created.
   *
   * Held here rather than in FakeDatabase because ordering writes: a test that
   * places an order then asks for its status has to see its own write.
   */
  interface FakeCommission {
    id: number;
    projectId: number;
    memberId: number;
    status: string;
    priceUsdcCents: number;
    treasuryShareBps: number;
    paymentReference: string | null;
    paidAt: Date | null;
    declineReason: string | null;
    deliveredAt: Date | null;
    createdAt: Date;
    openOrderKey: string | null;
    briefs: {
      revision: number;
      slot: string;
      textContent: string | null;
      colour: string | null;
      referencePath: string | null;
      note: string | null;
    }[];
  }

  /** When each member was first confirmed in a project's group. */
  const groupSeen = new Map<string, Date>();
  const commissions: FakeCommission[] = [];
  const waitlist: { projectId: number; memberId: number }[] = [];
  let nextCommissionId = 1;

  const withProject = (row: FakeCommission): unknown => ({
    ...row,
    project: { name: byId.get(row.projectId)?.name ?? 'Project' },
  });

  const commissionModel = {
    count: (args: { where: { projectId: number } }) =>
      Promise.resolve(
        (db.commissionsThisMonth?.get(args.where.projectId) ?? 0) +
          commissions.filter(
            (row) => row.projectId === args.where.projectId && row.status !== 'cancelled',
          ).length,
      ),
    findUnique: (args: {
      where: {
        id?: number;
        projectId_openOrderKey?: { projectId: number; openOrderKey: string };
      };
    }) => {
      const key = args.where.projectId_openOrderKey;
      const found =
        key === undefined
          ? commissions.find((row) => row.id === args.where.id)
          : commissions.find(
              (row) => row.projectId === key.projectId && row.openOrderKey === key.openOrderKey,
            );
      return Promise.resolve(found === undefined ? null : withProject(found));
    },
    findMany: (args: { where?: { memberId?: number; status?: { in?: string[] } } }) => {
      let rows = [...commissions];
      if (args.where?.memberId !== undefined) {
        rows = rows.filter((row) => row.memberId === args.where?.memberId);
      }
      const wanted = args.where?.status?.in;
      if (wanted !== undefined) {
        rows = rows.filter((row) => wanted.includes(row.status));
      }
      return Promise.resolve(rows.map(withProject));
    },
    create: (args: {
      data: {
        projectId: number;
        memberId: number;
        priceUsdcCents: number;
        treasuryShareBps: number;
        openOrderKey: string;
        briefs: { create: FakeCommission['briefs'][number] };
      };
    }) => {
      const clash = commissions.find(
        (row) =>
          row.projectId === args.data.projectId && row.openOrderKey === args.data.openOrderKey,
      );
      if (clash !== undefined) {
        // The real one-live-order index, as the code that catches it expects.
        return Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' }));
      }
      const row: FakeCommission = {
        id: nextCommissionId++,
        projectId: args.data.projectId,
        memberId: args.data.memberId,
        status: 'awaiting_payment',
        priceUsdcCents: args.data.priceUsdcCents,
        treasuryShareBps: args.data.treasuryShareBps,
        paymentReference: null,
        paidAt: null,
        declineReason: null,
        deliveredAt: null,
        createdAt: new Date(),
        openOrderKey: args.data.openOrderKey,
        briefs: [args.data.briefs.create],
      };
      commissions.push(row);
      return Promise.resolve({ id: row.id });
    },
    updateMany: (args: {
      where: { id: number; status: string };
      data: Record<string, unknown>;
    }) => {
      const row = commissions.find(
        (entry) => entry.id === args.where.id && entry.status === args.where.status,
      );
      if (row === undefined) {
        return Promise.resolve({ count: 0 });
      }
      Object.assign(row, args.data);
      return Promise.resolve({ count: 1 });
    },
  };

  const stub = {
    groupMembership: {
      upsert: (args: {
        where: { projectId_memberId: { projectId: number; memberId: number } };
      }) => {
        const { projectId, memberId } = args.where.projectId_memberId;
        const key = `${String(projectId)}:${String(memberId)}`;
        // Set once and never moved forward, exactly as the real one does —
        // an upsert that refreshed it would reset everybody's tenure.
        const existing = groupSeen.get(key);
        if (existing !== undefined) {
          return Promise.resolve({ knownSince: existing });
        }
        const knownSince = db.knownSince ?? new Date();
        groupSeen.set(key, knownSince);
        return Promise.resolve({ knownSince });
      },
      findUnique: (args: {
        where: { projectId_memberId: { projectId: number; memberId: number } };
      }) => {
        const { projectId, memberId } = args.where.projectId_memberId;
        const found = groupSeen.get(`${String(projectId)}:${String(memberId)}`);
        return Promise.resolve(found === undefined ? null : { knownSince: found });
      },
      deleteMany: () => Promise.resolve({ count: 0 }),
    },
    commissionSettings: {
      findUnique: (args: { where: { projectId: number } }) =>
        Promise.resolve(db.commissionTerms?.get(args.where.projectId) ?? null),
    },
    commission: commissionModel,
    commissionWaitlist: {
      upsert: (args: {
        where: { projectId_memberId: { projectId: number; memberId: number } };
      }) => {
        const { projectId, memberId } = args.where.projectId_memberId;
        if (!waitlist.some((row) => row.projectId === projectId && row.memberId === memberId)) {
          waitlist.push({ projectId, memberId });
        }
        return Promise.resolve({ id: waitlist.length });
      },
    },
    // placeOrder locks the project row and counts inside a transaction. The
    // fake runs the callback against the same models, which is enough to
    // exercise the flow — the locking itself is proved against real Postgres.
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(stub),
    $queryRaw: () => Promise.resolve([{ id: 1 }]),
    member: {
      findFirst: (args: { where: { handle?: string } }) =>
        Promise.resolve(
          args.where.handle === 'tester' || args.where.handle === 'holder'
            ? { id: args.where.handle === 'holder' ? 777 : 555 }
            : null,
        ),
      upsert: (args: { where: { platform_externalId: { externalId: string } } }) =>
        Promise.resolve({ id: Number(args.where.platform_externalId.externalId) }),
      findUnique: (args: { where: { id: number } }) =>
        // Identity as well as wallet state. Commission notifications read
        // platform and externalId to find the chat, and a fake that returned
        // only the wallet fields silently swallowed every notification while
        // the tests still passed.
        Promise.resolve({
          ...(wallets.get(args.where.id) ?? { walletAddress: null, walletLinkedAt: null }),
          platform: 'telegram',
          externalId: String(args.where.id),
        }),
      updateMany: (args: { where: { id: number } }) => {
        const held = wallets.get(args.where.id);
        if (held?.walletAddress == null) {
          return Promise.resolve({ count: 0 });
        }
        wallets.set(args.where.id, { walletAddress: null, walletLinkedAt: null });
        return Promise.resolve({ count: 1 });
      },
    },
    walletChallenge: {
      count: (args: { where: { memberId: number; createdAt: { gte: Date } } }) =>
        Promise.resolve(
          challenges.filter(
            (row) =>
              row.memberId === args.where.memberId && row.createdAt >= args.where.createdAt.gte,
          ).length,
        ),
      findFirst: (args: { where: { memberId: number } }) =>
        Promise.resolve(
          challenges.filter((row) => row.memberId === args.where.memberId)[0] ?? null,
        ),
      create: (args: { data: { memberId: number } }) => {
        challenges.push({ memberId: args.data.memberId, createdAt: new Date() });
        return Promise.resolve({ id: challenges.length });
      },
    },
    project: {
      findFirst: (args: { where: { announceChannelId?: string } }) => {
        const bound = db.groupBinding;
        if (bound === undefined || bound.groupId !== args.where.announceChannelId) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          id: bound.projectId,
          name: bound.name,
          eligibilityRule: db.eligibilityRule ?? {},
        });
      },
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
          // The entry lookup carries the eligibility rule through, and a fake
          // that omitted it made every gated project look open.
          eligibilityRule: db.eligibilityRule ?? {},
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
        // Three callers land here now: the claimed-hash scan for a project,
        // the per-member lookups behind /mine and /collection, and /verify
        // asking what one member holds.
        if (args.where.memberId !== undefined) {
          return Promise.resolve(db.claimsByMember?.get(args.where.memberId) ?? []);
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
  /**
   * The same calls with their untouched payloads, for assertions about options
   * that never reach a caption — link previews, parse modes, keyboards.
   */
  readonly rawCalls: { method: string; payload: Record<string, unknown> }[];
  countOf(method: string): number;
  send(text: string, userId?: number): Promise<void>;
  sendInGroup(text: string, groupId: number, userId?: number): Promise<void>;
  press(data: string, messageId: number, userId?: number): Promise<void>;
}

export interface HarnessOptions {
  readonly db?: FakeDatabase;
  readonly rateLimiter?: RateLimiter;
  readonly renderCache?: RenderCache;
  readonly traitRoot?: string;
  readonly claimRoot?: string;
  /** Telegram ids allowed to work the commission queue. Empty authorises nobody. */
  readonly adminIds?: readonly string[];
  /**
   * What getChatMember should report, for eligibility checks.
   *
   * 'error' makes the call throw, which is the case that matters most: a gate
   * that cannot be checked has to refuse, and there is no other way to drive
   * that path.
   */
  readonly chatMemberStatus?:
    'member' | 'administrator' | 'creator' | 'restricted' | 'left' | 'kicked' | 'error';
  readonly publicBaseUrl?: string;
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
  const rawCalls: { method: string; payload: Record<string, unknown> }[] = [];
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
    publicBaseUrl: options.publicBaseUrl,
    adminIds: (options.adminIds ?? []).map((externalId) => ({
      platform: 'telegram',
      externalId,
    })),
    traitRoot: options.traitRoot ?? '.',
    claimRoot: options.claimRoot ?? '.',
    // Silenced: these tests assert on replies, not on log output.
    logger: createLogger({ level: 'error', write: () => undefined }),
    botInfo: BOT_INFO,
  });

  // Intercept outbound API calls instead of letting them reach Telegram.
  bot.api.config.use((_prev, method, payload) => {
    // Eligibility asks Telegram whether somebody is in a group. 'error' makes
    // it throw, which is the path that has to refuse.
    if (method === 'getChatMember') {
      const status = options.chatMemberStatus ?? 'member';
      if (status === 'error') {
        return Promise.reject(new Error('Bad Request: chat not found'));
      }
      return Promise.resolve({ ok: true, result: { status, user: { id: 0 } } } as never);
    }

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
    rawCalls.push({ method, payload });
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
    rawCalls,
    countOf(method: string): number {
      return calls.filter((call) => call.method === method).length;
    },
    /** Sends into a group chat, which is the only place /verify runs. */
    async sendInGroup(text: string, groupId: number, userId = 555): Promise<void> {
      updateId += 1;
      const command = /^\/[a-z_]+/.exec(text);
      await bot.handleUpdate({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: groupId, type: 'supergroup', title: 'Community' },
          from: { id: userId, is_bot: false, first_name: 'Tester', username: 'tester' },
          text,
          entities: command ? [{ type: 'bot_command', offset: 0, length: command[0].length }] : [],
        },
      });
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
          // Any leading /command, not just /start. grammY routes on the
          // entity, so a command without one is silently never dispatched —
          // which reads in a test exactly like a handler that does nothing.
          entities: /^\/[a-z_]+/.exec(text)
            ? [
                {
                  type: 'bot_command',
                  offset: 0,
                  length: (/^\/[a-z_]+/.exec(text) ?? [''])[0].length,
                },
              ]
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
