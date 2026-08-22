import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot } from '../../src/bot/bot.js';
import { createRateLimiter } from '../../src/bot/rate-limit.js';
import { createInMemorySessionStore } from '../../src/bot/session.js';
import type { RateLimiter } from '../../src/bot/rate-limit.js';
import type { SessionStore } from '../../src/bot/session.js';
import type { EntryExistingClaim, EntryProject } from '../../src/bot/entry.js';
import { createLogger } from '../../src/logging/logger.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Drives the real bot with synthetic updates.
 *
 * Nothing is stubbed except the two edges — Telegram and Postgres — so the
 * middleware, the command handler, the payload parser and the entry resolver
 * under test are exactly the ones that run in production.
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
}

/**
 * A stand-in for the three queries the start handler makes. Built as a plain
 * object and cast once, rather than reaching for `any` at each call site.
 */
export function fakePrisma(db: FakeDatabase): PrismaClient {
  const stub = {
    member: {
      upsert: (args: { where: { telegramUserId: bigint } }) =>
        Promise.resolve({ id: Number(args.where.telegramUserId) }),
    },
    project: {
      findUnique: (args: { where: { slug: string } }) =>
        Promise.resolve(db.projectsBySlug.get(args.where.slug) ?? null),
    },
    claim: {
      findUnique: (args: {
        where: { projectId_memberId: { projectId: number; memberId: number } };
      }) => {
        const { projectId, memberId } = args.where.projectId_memberId;
        return Promise.resolve(
          db.claimsByProjectAndMember.get(`${String(projectId)}:${String(memberId)}`) ?? null,
        );
      },
    },
  };

  return stub as unknown as PrismaClient;
}

export interface Harness {
  readonly bot: Bot;
  readonly sessions: SessionStore;
  /** Every text the bot tried to send, in order. */
  readonly sent: string[];
  send(text: string, userId?: number): Promise<void>;
}

export interface HarnessOptions {
  readonly db?: FakeDatabase;
  readonly rateLimiter?: RateLimiter;
}

const EMPTY_DB: FakeDatabase = {
  projectsBySlug: new Map(),
  claimsByProjectAndMember: new Map(),
};

export function createHarness(options: HarnessOptions = {}): Harness {
  const sent: string[] = [];
  const sessions = createInMemorySessionStore();

  const bot = createBot({
    token: '123456789:AAHtesttesttesttesttesttesttesttest1',
    prisma: fakePrisma(options.db ?? EMPTY_DB),
    sessions,
    rateLimiter: options.rateLimiter ?? createRateLimiter({ limit: 1000, windowMs: 60_000 }),
    // Silenced: these tests assert on replies, not on log output.
    logger: createLogger({ level: 'error', write: () => undefined }),
    botInfo: BOT_INFO,
  });

  // Intercept outbound API calls instead of letting them reach Telegram.
  bot.api.config.use((_prev, method, payload) => {
    if (method === 'sendMessage' && 'text' in payload && typeof payload.text === 'string') {
      sent.push(payload.text);
    }
    return Promise.resolve({ ok: true, result: true } as never);
  });

  let updateId = 0;

  return {
    bot,
    sessions,
    sent,
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
