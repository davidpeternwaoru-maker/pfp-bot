/**
 * Awards a reserved combination to a member from the command line.
 *
 * Authorisation is an allowlist of Telegram user ids in ADMIN_TELEGRAM_IDS.
 * There is deliberately no password: a shared secret in an operator's shell
 * history is worse than a list of ids in the environment.
 *
 *   npm run award -- --issuer 123456789 \
 *                    --project test-live \
 *                    --to @someone \
 *                    --traits 12,19,27,31
 *
 * --to takes either @username or a numeric Telegram user id.
 */
import { loadEnv } from '../src/config/env.js';
import { awardCombination } from '../src/claim/award-service.js';
import { createPrismaClient } from '../src/db/client.js';
import { fetchTraitPack } from '../src/db/trait-pack-repository.js';
import { createLogger } from '../src/logging/logger.js';

interface Args {
  readonly issuer: string;
  readonly project: string;
  readonly to: string;
  readonly traits: string;
}

function parseArgs(argv: readonly string[]): Partial<Args> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) {
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      continue;
    }
    args[token.slice(2)] = value;
    i += 1;
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL });

for (const required of ['issuer', 'project', 'to', 'traits'] as const) {
  if (args[required] === undefined) {
    fail(`missing --${required}`);
  }
}

const issuerRaw = args.issuer ?? '';
if (!/^\d{1,19}$/.test(issuerRaw)) {
  fail('--issuer must be a numeric Telegram user id');
}
const issuer = BigInt(issuerRaw);

// Fail closed. An empty allowlist authorises nobody.
if (!env.ADMIN_TELEGRAM_IDS.includes(issuer)) {
  fail(`user ${issuerRaw} is not in ADMIN_TELEGRAM_IDS`);
}

const slug = args.project ?? '';
if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
  fail('--project must be a lowercase slug');
}

const traitIds = (args.traits ?? '')
  .split(',')
  .map((part) => part.trim())
  .filter((part) => part.length > 0)
  .map((part) => Number(part));

if (traitIds.length === 0 || traitIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
  fail('--traits must be a comma-separated list of positive trait ids');
}

const prisma = createPrismaClient(env.DATABASE_URL);

try {
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (project === null) {
    fail(`no project with slug "${slug}"`);
  }

  const recipient = args.to ?? '';
  const member = recipient.startsWith('@')
    ? await prisma.member.findFirst({
        where: { username: recipient.slice(1) },
        select: { id: true, username: true, telegramUserId: true },
      })
    : await prisma.member.findUnique({
        where: { telegramUserId: BigInt(/^\d{1,19}$/.test(recipient) ? recipient : '0') },
        select: { id: true, username: true, telegramUserId: true },
      });

  if (member === null) {
    fail(
      `no member matches "${recipient}". A member exists only after they have opened the bot at least once.`,
    );
  }

  const pack = await fetchTraitPack(prisma, project.id);
  const outcome = await awardCombination({
    prisma,
    pack,
    memberId: member.id,
    traitIds,
    traitRoot: env.TRAIT_ROOT,
    claimRoot: env.CLAIM_ROOT,
  });

  switch (outcome.kind) {
    case 'awarded':
      // Every award is logged with who issued it and to whom. These are
      // operator identifiers in an operator-run tool, not member chat data.
      logger.info('award.issued', {
        issuer: issuerRaw,
        recipientMemberId: member.id,
        recipientTelegramUserId: String(member.telegramUserId),
        projectId: project.id,
        projectSlug: slug,
        traitIds: traitIds.join(','),
        editionNumber: outcome.editionNumber,
      });
      process.stdout.write(
        [
          `Awarded edition #${String(outcome.editionNumber)} of ${project.name}`,
          `  to        ${member.username === null ? String(member.telegramUserId) : `@${member.username}`}`,
          `  traits    ${traitIds.join(', ')}`,
          `  artwork   ${outcome.imagePath}`,
          '',
        ].join('\n'),
      );
      break;

    case 'combination-taken':
      logger.warn('award.refused', { issuer: issuerRaw, reason: 'combination-taken' });
      fail('that combination is already held by somebody. Nothing was written.');
      break;

    case 'invalid-combination':
      fail(`those traits do not form one complete combination: ${outcome.reason}`);
      break;

    case 'not-reserved':
      fail(
        'every named trait is open-tier. Awards are for reserved artwork; an open combination should be rolled, not awarded.',
      );
      break;

    case 'project-missing':
      fail('the project disappeared while awarding. Nothing was written.');
      break;
  }
} finally {
  await prisma.$disconnect();
}
