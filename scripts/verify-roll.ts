/**
 * Drives the real bot against the real database and the real trait pack,
 * intercepting only the Telegram API. Proves the roll path end to end without
 * anyone tapping buttons in a chat.
 *
 *   npm run verify:roll
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { createBot } from '../src/bot/bot.js';
import { createRateLimiter } from '../src/bot/rate-limit.js';
import { createInMemorySessionStore } from '../src/bot/session.js';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClient } from '../src/db/client.js';
import { createRenderCache } from '../src/render/cache.js';
import { createLogger } from '../src/logging/logger.js';
import { fetchTraitPack } from '../src/db/trait-pack-repository.js';
import { drawUnclaimed } from '../src/roll/pool.js';

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const sessions = createInMemorySessionStore();
const renderCache = createRenderCache();

const calls: { method: string; caption?: string }[] = [];
const images: Buffer[] = [];
let nextMessageId = 5000;

const bot = createBot({
  token: env.TELEGRAM_BOT_TOKEN,
  prisma,
  sessions,
  rateLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
  renderCache,
  traitRoot: env.TRAIT_ROOT,
  claimRoot: env.CLAIM_ROOT,
  logger: createLogger({ level: 'error' }),
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

/**
 * Pulls the PNG bytes back out of the InputFile handed to sendPhoto.
 * Reaches for a private field, which is fine in a verification script and
 * would not be acceptable in src/.
 */
function extractImage(value: unknown): Buffer | null {
  if (value === null || typeof value !== 'object' || !('fileData' in value)) {
    return null;
  }
  const data = value.fileData;
  return Buffer.isBuffer(data) ? data : null;
}

bot.api.config.use((_prev, method, payload) => {
  const caption =
    'caption' in payload && typeof payload.caption === 'string' ? payload.caption : undefined;
  calls.push(caption === undefined ? { method } : { method, caption });

  if (method === 'sendPhoto' && 'photo' in payload) {
    const image = extractImage(payload.photo);
    if (image !== null) {
      images.push(image);
    }
  }
  if (method === 'editMessageMedia' && 'media' in payload) {
    const media = payload.media as { media?: unknown };
    const image = extractImage(media.media);
    if (image !== null) {
      images.push(image);
    }
  }

  if (method === 'sendPhoto' || method === 'sendMessage') {
    nextMessageId += 1;
    return Promise.resolve({ ok: true, result: { message_id: nextMessageId } } as never);
  }
  return Promise.resolve({ ok: true, result: true } as never);
});

const USER_ID = 999_000_001;
let updateId = 0;

async function send(text: string): Promise<void> {
  updateId += 1;
  const update: Update = {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: USER_ID, type: 'private', first_name: 'Verifier' },
      from: { id: USER_ID, is_bot: false, first_name: 'Verifier' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  };
  await bot.handleUpdate(update);
}

async function press(data: string, messageId: number): Promise<void> {
  updateId += 1;
  const update: Update = {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: USER_ID, is_bot: false, first_name: 'Verifier' },
      chat_instance: 'verify',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_ID, type: 'private', first_name: 'Verifier' },
      },
    },
  };
  await bot.handleUpdate(update);
}

await send('/start test-live');

const session = await sessions.get(USER_ID, 0);
const anySession = session ?? (await sessions.findByMessage(USER_ID, 5001));
const messageId = anySession?.messageId ?? 5001;

// Twenty interactions: alternating rerolls and slot adjustments.
for (let i = 0; i < 20; i += 1) {
  await press(i % 3 === 0 ? 'r' : `s${String(i % 4)}`, messageId);
}

// Reserved artwork must be unreachable by rolling against the real pack, not
// just against a fixture. Cheap to check, and it is the promise made to
// whoever holds an awarded legendary.
const livePack = await fetchTraitPack(prisma, 3);
const reserved = new Set(
  livePack.slots.flatMap((slot) => slot.traits.filter((t) => t.tier !== 'open').map((t) => t.id)),
);
let reservedSeen = 0;
for (let i = 0; i < 5_000; i += 1) {
  const drawn = drawUnclaimed({ pack: livePack, isClaimed: () => false });
  if (drawn.kind === 'drawn' && drawn.traits.some((t) => reserved.has(t.id))) {
    reservedSeen += 1;
  }
}

const outDir = join('output', 'verify');
await mkdir(outDir, { recursive: true });
for (const [index, image] of images.slice(0, 4).entries()) {
  await writeFile(join(outDir, `roll-${String(index + 1)}.png`), image);
}

const captions = calls.map((call) => call.caption).filter((c): c is string => c !== undefined);
const lastCaption = captions[captions.length - 1] ?? '(none)';

const sendPhotoCount = calls.filter((c) => c.method === 'sendPhoto').length;
const editCount = calls.filter((c) => c.method === 'editMessageMedia').length;
const answerCount = calls.filter((c) => c.method === 'answerCallbackQuery').length;
const textCount = calls.filter((c) => c.method === 'sendMessage').length;

process.stdout.write(
  [
    '',
    `sendPhoto           ${String(sendPhotoCount)}   (must be 1 — one message per session)`,
    `editMessageMedia    ${String(editCount)}`,
    `answerCallbackQuery ${String(answerCount)}   (must equal the 20 presses)`,
    `sendMessage         ${String(textCount)}`,
    `distinct images     ${String(new Set(images.map((i) => i.length)).size)} of ${String(images.length)} by size`,
    `render cache        ${String(renderCache.size())} entries`,
    `reserved traits     ${String(reserved.size)} in pack, seen in ${String(reservedSeen)} of 5000 draws (must be 0)`,
    `samples written     ${outDir}`,
    '',
    'final caption:',
    ...lastCaption.split('\n').map((line: string) => `  ${line}`),
    '',
  ].join('\n'),
);

await prisma.$disconnect();
