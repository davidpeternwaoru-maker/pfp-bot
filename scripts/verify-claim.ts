/**
 * Walks a whole claim against the real database and the real trait pack:
 * roll, confirm, claim, then fetch it back with /mine. Cleans up after itself.
 *
 * Deliberately configures the project to announce into a group that does not
 * exist, because "an announcement failure must never fail a claim" is only
 * proved by a claim surviving one.
 *
 *   npm run verify:claim
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Update } from 'grammy/types';
import { createBot } from '../src/bot/bot.js';
import { createRateLimiter } from '../src/bot/rate-limit.js';
import { createInMemorySessionStore } from '../src/bot/session.js';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClient } from '../src/db/client.js';
import { createRenderCache } from '../src/render/cache.js';
import { createLogger } from '../src/logging/logger.js';

const SLUG = 'test-live';
const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const sessions = createInMemorySessionStore();

const logLines: string[] = [];
const calls: { method: string; text?: string }[] = [];
let nextMessageId = 8000;

const bot = createBot({
  token: env.TELEGRAM_BOT_TOKEN,
  prisma,
  sessions,
  rateLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
  renderCache: createRenderCache(),
  traitRoot: env.TRAIT_ROOT,
  claimRoot: env.CLAIM_ROOT,
  logger: createLogger({ level: 'info', write: (line) => logLines.push(line) }),
  botInfo: {
    id: 1,
    is_bot: true,
    first_name: 'Verifier',
    username: 'verifier',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  },
});

/** editMessageMedia nests its caption inside `media`; everything else is flat. */
function extractText(payload: Record<string, unknown>): string | undefined {
  if (typeof payload['text'] === 'string') {
    return payload['text'];
  }
  if (typeof payload['caption'] === 'string') {
    return payload['caption'];
  }
  const media = payload['media'];
  if (typeof media === 'object' && media !== null && 'caption' in media) {
    const nested = (media as { caption?: unknown }).caption;
    return typeof nested === 'string' ? nested : undefined;
  }
  return undefined;
}

bot.api.config.use((_prev, method, payload) => {
  const text = extractText(payload);
  calls.push(text === undefined ? { method } : { method, text });

  // The announcement group does not exist. Telegram would reject it, so the
  // interceptor does too — that is the point of this run.
  if (method === 'sendMessage' && 'chat_id' in payload && payload.chat_id === -1) {
    return Promise.reject(new Error('Bad Request: chat not found'));
  }

  if (method === 'sendPhoto' || method === 'sendMessage' || method === 'sendDocument') {
    nextMessageId += 1;
    return Promise.resolve({ ok: true, result: { message_id: nextMessageId } } as never);
  }
  return Promise.resolve({ ok: true, result: true } as never);
});

const TELEGRAM_USER_ID = 990_000_000 + (Date.now() % 1_000_000);
let updateId = 0;

async function send(text: string): Promise<void> {
  updateId += 1;
  await bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: TELEGRAM_USER_ID, type: 'private', first_name: 'Verifier' },
      from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: 'Verifier' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 6 }],
    },
  } satisfies Update);
}

async function press(data: string, messageId: number): Promise<void> {
  updateId += 1;
  await bot.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: 'Verifier' },
      chat_instance: 'verify',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: TELEGRAM_USER_ID, type: 'private', first_name: 'Verifier' },
      },
    },
  } satisfies Update);
}

function report(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}\n`,
  );
}

const projectRow = await prisma.project.findUniqueOrThrow({
  where: { slug: SLUG },
  select: { id: true, announceOnClaim: true, telegramGroupId: true },
});

// Point announcements at a group that cannot receive them.
await prisma.project.update({
  where: { id: projectRow.id },
  data: { announceOnClaim: true, telegramGroupId: BigInt(-1) },
});

try {
  await send(`/start ${SLUG}`);
  const rollMessageId = 8001;

  await press('c', rollMessageId);
  const confirmed = calls.some(
    (call) => call.method === 'editMessageCaption' && call.text?.includes('permanent') === true,
  );
  report('confirmation is required before claiming', confirmed);

  await press('k', rollMessageId);

  const claim = await prisma.claim.findFirst({
    where: { projectId: projectRow.id, member: { telegramUserId: BigInt(TELEGRAM_USER_ID) } },
    select: {
      id: true,
      editionNumber: true,
      combinationHash: true,
      contentHash: true,
      imagePath: true,
      traitIds: true,
      memberId: true,
    },
  });

  report(
    'claim row written',
    claim !== null,
    claim === null ? '' : `edition #${String(claim.editionNumber)}`,
  );

  if (claim !== null) {
    report(
      'artwork persisted',
      existsSync(resolve(env.CLAIM_ROOT, claim.imagePath)),
      claim.imagePath,
    );
    report('combination hash stored', claim.combinationHash.length === 64);
    report('content hash stored', claim.contentHash.length === 64);

    const finalImage = calls.some(
      (call) =>
        call.method === 'editMessageMedia' &&
        call.text?.includes(`#${String(claim.editionNumber)}`) === true,
    );
    report('final image shows the edition number', finalImage);

    const announceFailed = logLines.some((line) => line.includes('announce.failed'));
    const claimCompleted = logLines.some((line) => line.includes('claim.completed'));
    report('announcement failure was logged', announceFailed);
    report('claim survived the failed announcement', claimCompleted && claim !== null);

    // A second attempt by the same member must be refused.
    await send(`/start ${SLUG}`);
    const refused = (calls.at(-1)?.text ?? '').includes(`#${String(claim.editionNumber)}`);
    report('second entry shows the existing claim', refused);

    await send(`/mine ${SLUG}`);
    const delivered = calls.some((call) => call.method === 'sendDocument');
    report('/mine returns the full-resolution file', delivered);

    await prisma.claim.delete({ where: { id: claim.id } });
    await prisma.member.deleteMany({ where: { id: claim.memberId } });
  }
} finally {
  await prisma.project.update({
    where: { id: projectRow.id },
    data: {
      announceOnClaim: projectRow.announceOnClaim,
      telegramGroupId: projectRow.telegramGroupId,
    },
  });
  await prisma.$disconnect();
}
