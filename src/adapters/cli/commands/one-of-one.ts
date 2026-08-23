import { issueOneOfOne, TraitImageError } from '../../../core/ports.js';
import type { OneOfOneKind } from '../../../core/ports.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { Logger } from '../../../logging/logger.js';
import { requireFlag, requireIdentity, requireMemberReference, requireSlug } from '../args.js';
import type { ParsedArgs, PlatformIdentity } from '../args.js';
import { requireAdmin } from '../authorise.js';
import { confirmDestructive } from '../confirm.js';
import { CliError } from '../errors.js';
import { keyValue } from '../format.js';
import { requireProject, requireRecipient } from '../lookup.js';

/**
 * Issuing pre-rendered artwork: a bespoke piece, or a finished commission.
 *
 * One command body for both. They differ in exactly two ways that matter here
 * — whether the piece is transferable and which member slot it occupies — and
 * both of those are decided inside insertClaim from the kind. Writing them as
 * two commands would be writing the same validation, confirmation and
 * reporting twice and hoping the copies stay identical.
 */

export interface IssueContext {
  readonly adminIds: readonly PlatformIdentity[];
  /** Where an operator's finished artwork is read from. */
  readonly traitRoot: string;
  readonly claimRoot: string;
  readonly logger: Logger;
}

const WORDING: Record<OneOfOneKind, { readonly action: string; readonly noun: string }> = {
  bespoke: { action: 'issue-bespoke', noun: 'a bespoke one-of-one' },
  custom: { action: 'issue-custom', noun: 'a commissioned one-of-one' },
};

export async function issueOneOfOneCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
  context: IssueContext,
  kind: OneOfOneKind,
): Promise<number> {
  const { action, noun } = WORDING[kind];

  const issuer = requireIdentity(args, 'issuer');
  const slug = requireSlug(args, 'project');
  const to = requireMemberReference(args, 'to');
  const file = requireFlag(args, 'file');

  const issuerLabel = requireAdmin(issuer, context.adminIds, action, slug, context.logger);

  const project = await requireProject(prisma, slug);
  const recipient = await requireRecipient(prisma, to);

  await confirmDestructive({
    summary:
      `This will permanently issue ${noun} in ${project.name} to ${recipient.label}:\n` +
      `  artwork: ${file}\n` +
      (kind === 'custom'
        ? '  non-transferable, and excluded from all rarity statistics.\n'
        : '  transferable, and counted in rarity statistics like any other claim.\n') +
      'Issued artwork cannot be undone from this tool.',
    expect: slug,
    assumeYes: args.switches.has('yes'),
  });

  const outcome = await issueOneOfOne({
    prisma,
    projectId: project.id,
    canvas: { width: project.canvasWidth, height: project.canvasHeight },
    memberId: recipient.id,
    kind,
    sourcePath: file,
    sourceRoot: context.traitRoot,
    claimRoot: context.claimRoot,
  }).catch((error: unknown) => {
    // The artwork failed the same checks the trait importer applies. That is
    // an operator fixing a file, not a fault, so it reads as one line.
    if (error instanceof TraitImageError) {
      throw new CliError(`that artwork cannot be issued: ${error.message}`);
    }
    throw error;
  });

  switch (outcome.kind) {
    case 'issued':
      // Logged with both parties, because issuing is a privileged action and
      // the log is the only record of who authorised it.
      context.logger.info(`${action}.issued`, {
        issuer: issuerLabel,
        recipientMemberId: recipient.id,
        projectId: project.id,
        editionNumber: outcome.editionNumber,
      });
      write(
        `${keyValue([
          ['issued', `edition #${String(outcome.editionNumber)} of ${project.name}`],
          ['kind', kind],
          ['to', recipient.label],
          ['issued by', issuerLabel],
          ['artwork', outcome.imagePath],
        ])}\n`,
      );
      return 0;

    case 'artwork-taken':
      throw new CliError(
        'that exact artwork is already held by somebody in this project. ' +
          'A one-of-one is identified by its image, so the same file cannot be issued twice.',
      );

    case 'member-already-holds':
      throw new CliError(
        `${recipient.label} already holds a commission in ${project.name}. ` +
          'A member may hold one commission per project; issue this one elsewhere or check theirs with stats.',
      );

    case 'project-missing':
      throw new CliError(`no project with slug "${slug}"`);
  }
}
