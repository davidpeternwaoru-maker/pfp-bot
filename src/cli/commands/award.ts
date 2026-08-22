import { awardCombination } from '../../claim/award-service.js';
import { fetchTraitPack } from '../../db/trait-pack-repository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Logger } from '../../logging/logger.js';
import { normaliseUsername } from '../../bot/payload.js';
import { optionalFlag, requireIdList, requireSlug, requireTelegramId } from '../args.js';
import type { ParsedArgs } from '../args.js';
import { confirmDestructive } from '../confirm.js';
import { CliError } from '../errors.js';
import { keyValue } from '../format.js';

/**
 * Hands a reserved combination to a member.
 *
 * Authorisation is an allowlist of Telegram user ids in ADMIN_TELEGRAM_IDS.
 * There is deliberately no password: a shared secret in an operator's shell
 * history is worse than a list of ids in the environment, and the ids are
 * already the identities the bot understands.
 */
export async function awardCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
  context: {
    readonly adminIds: readonly bigint[];
    readonly traitRoot: string;
    readonly claimRoot: string;
    readonly logger: Logger;
  },
): Promise<number> {
  const issuer = requireTelegramId(args, 'issuer');
  const slug = requireSlug(args, 'project');
  const traitIds = requireIdList(args, 'traits');

  const toRaw = optionalFlag(args, 'to');
  if (toRaw === undefined) {
    throw new CliError('missing --to (a numeric Telegram user id, or @username)');
  }

  // Fail closed, and before anything is read from the database.
  if (context.adminIds.length === 0) {
    throw new CliError(
      'ADMIN_TELEGRAM_IDS is empty, so nobody is authorised to award. Set it and retry.',
    );
  }
  if (!context.adminIds.includes(issuer)) {
    context.logger.warn('award.refused', { issuer: String(issuer), project: slug });
    throw new CliError(`Telegram id ${String(issuer)} is not in ADMIN_TELEGRAM_IDS`);
  }

  const project = await prisma.project.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (project === null) {
    throw new CliError(`no project with slug "${slug}"`);
  }

  const recipient = toRaw.startsWith('@')
    ? await prisma.member.findFirst({
        where: { username: normaliseUsername(toRaw.slice(1)) },
        select: { id: true, telegramUserId: true, username: true },
      })
    : await prisma.member.findUnique({
        where: { telegramUserId: BigInt(/^\d{1,19}$/.test(toRaw) ? toRaw : '0') },
        select: { id: true, telegramUserId: true, username: true },
      });

  if (recipient === null) {
    throw new CliError(
      `no member matches "${toRaw}". They must have opened the bot at least once first.`,
    );
  }

  const pack = await fetchTraitPack(prisma, project.id);
  const byId = new Map(
    pack.slots.flatMap((slot) => slot.traits.map((trait) => [trait.id, trait] as const)),
  );

  const traits = traitIds.map((id) => {
    const trait = byId.get(id);
    if (trait === undefined) {
      throw new CliError(`trait ${String(id)} does not belong to ${project.name}`);
    }
    return trait;
  });

  await confirmDestructive({
    summary:
      `This will permanently award a claim in ${project.name} to ` +
      `${recipient.username === null ? String(recipient.telegramUserId) : `@${recipient.username}`}:\n` +
      traits.map((trait) => `  ${trait.slot}: ${trait.name} (${trait.tier})`).join('\n') +
      '\nAwards cannot be undone from this tool.',
    expect: slug,
    assumeYes: args.switches.has('yes'),
  });

  const outcome = await awardCombination({
    prisma,
    pack,
    memberId: recipient.id,
    traitIds,
    traitRoot: context.traitRoot,
    claimRoot: context.claimRoot,
  });

  const recipientLabel =
    recipient.username === null ? String(recipient.telegramUserId) : `@${recipient.username}`;

  switch (outcome.kind) {
    case 'awarded':
      // Logged with both parties, because an award is a privileged action and
      // the log is the only record of who authorised it.
      context.logger.info('award.issued', {
        issuer: String(issuer),
        recipientMemberId: recipient.id,
        projectId: project.id,
        editionNumber: outcome.editionNumber,
      });
      write(
        `${keyValue([
          ['awarded', `edition #${String(outcome.editionNumber)} of ${project.name}`],
          ['to', recipientLabel],
          ['issued by', String(issuer)],
          ['artwork', outcome.imagePath],
        ])}\n`,
      );
      return 0;

    case 'combination-taken':
      throw new CliError('that exact combination is already held by somebody in this project');

    case 'invalid-combination':
      throw new CliError(`that is not a legal combination: ${outcome.reason}`);

    case 'not-reserved':
      // An award of an all-open combination would silently consume a
      // combination a member could have rolled for themselves.
      throw new CliError(
        'none of those traits is gated or legendary. Awards are for reserved artwork; ' +
          'an open combination should be rolled, not handed out.',
      );

    case 'project-missing':
      throw new CliError(`no project with slug "${slug}"`);
  }
}
