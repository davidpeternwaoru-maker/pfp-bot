import {
  awardCombination,
  fetchTraitPack,
  findMemberByHandle,
  findMemberByIdentity,
} from '../../../core/ports.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { Logger } from '../../../logging/logger.js';
import { requireIdentity, requireIdList, requireMemberReference, requireSlug } from '../args.js';
import type { PlatformIdentity } from '../args.js';
import type { ParsedArgs } from '../args.js';
import { confirmDestructive } from '../confirm.js';
import { CliError } from '../errors.js';
import { keyValue } from '../format.js';

/**
 * Hands a reserved combination to a member.
 *
 * Authorisation is an allowlist of platform-qualified ids in ADMIN_IDS, e.g.
 * "telegram:8853090779". There is deliberately no password: a shared secret in
 * an operator's shell history is worse than a list of ids in the environment,
 * and these are already the identities the product understands.
 */
export async function awardCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
  context: {
    readonly adminIds: readonly PlatformIdentity[];
    readonly traitRoot: string;
    readonly claimRoot: string;
    readonly logger: Logger;
  },
): Promise<number> {
  const issuer = requireIdentity(args, 'issuer');
  const slug = requireSlug(args, 'project');
  const traitIds = requireIdList(args, 'traits');
  const to = requireMemberReference(args, 'to');

  const issuerLabel = `${issuer.platform}:${issuer.externalId}`;

  // Fail closed, and before anything is read from the database.
  if (context.adminIds.length === 0) {
    throw new CliError('ADMIN_IDS is empty, so nobody is authorised to award. Set it and retry.');
  }
  // Both halves must match: an id that is an admin on one platform is somebody
  // else entirely on another.
  const authorised = context.adminIds.some(
    (admin) => admin.platform === issuer.platform && admin.externalId === issuer.externalId,
  );
  if (!authorised) {
    context.logger.warn('award.refused', { issuer: issuerLabel, project: slug });
    throw new CliError(`${issuerLabel} is not in ADMIN_IDS`);
  }

  const project = await prisma.project.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (project === null) {
    throw new CliError(`no project with slug "${slug}"`);
  }

  const recipient =
    to.kind === 'handle'
      ? await findMemberByHandle(prisma, to.platform, to.handle)
      : await findMemberByIdentity(prisma, to.platform, to.externalId).then((found) =>
          found === null ? null : { ...found, externalId: to.externalId, handle: null },
        );

  if (recipient === null) {
    const shown =
      to.kind === 'handle' ? `${to.platform}:@${to.handle}` : `${to.platform}:${to.externalId}`;
    throw new CliError(
      `no member matches "${shown}". They must have used the bot at least once first.`,
    );
  }

  const recipientLabel =
    recipient.handle === null
      ? `${to.platform}:${recipient.externalId}`
      : `${to.platform}:@${recipient.handle}`;

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
      `${recipientLabel}:\n` +
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

  switch (outcome.kind) {
    case 'awarded':
      // Logged with both parties, because an award is a privileged action and
      // the log is the only record of who authorised it.
      context.logger.info('award.issued', {
        issuer: issuerLabel,
        recipientMemberId: recipient.id,
        projectId: project.id,
        editionNumber: outcome.editionNumber,
      });
      write(
        `${keyValue([
          ['awarded', `edition #${String(outcome.editionNumber)} of ${project.name}`],
          ['to', recipientLabel],
          ['issued by', issuerLabel],
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
