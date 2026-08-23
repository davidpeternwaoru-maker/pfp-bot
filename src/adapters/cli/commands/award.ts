import { awardCombination, fetchTraitPack } from '../../../core/ports.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { Logger } from '../../../logging/logger.js';
import { requireIdentity, requireIdList, requireMemberReference, requireSlug } from '../args.js';
import type { ParsedArgs, PlatformIdentity } from '../args.js';
import { requireAdmin } from '../authorise.js';
import { confirmDestructive } from '../confirm.js';
import { CliError } from '../errors.js';
import { keyValue } from '../format.js';
import { requireProject, requireRecipient } from '../lookup.js';

/**
 * Hands a reserved trait combination to a member.
 *
 * This is artwork composited from trait rows, so it stays an `open` claim type
 * and counts in trait supply exactly as a rolled one does. For a one-of-one
 * piece that has no combination at all, see issue-bespoke.
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

  const issuerLabel = requireAdmin(issuer, context.adminIds, 'award', slug, context.logger);

  const project = await requireProject(prisma, slug);
  const recipient = await requireRecipient(prisma, to);

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
      `${recipient.label}:\n` +
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
          ['to', recipient.label],
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
