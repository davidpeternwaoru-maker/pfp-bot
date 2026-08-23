import { findMemberByHandle, findMemberByIdentity } from '../../core/ports.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { MemberReference } from './args.js';
import { CliError } from './errors.js';

/** Resolving the two things almost every command names: a project and a member. */

export interface ProjectRow {
  readonly id: number;
  readonly name: string;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export async function requireProject(prisma: PrismaClient, slug: string): Promise<ProjectRow> {
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { id: true, name: true, canvasWidth: true, canvasHeight: true },
  });
  if (project === null) {
    throw new CliError(`no project with slug "${slug}"`);
  }
  return project;
}

export interface Recipient {
  readonly id: number;
  /** How to name them back to the operator, never an internal id. */
  readonly label: string;
}

/**
 * Turns a --to reference into a member.
 *
 * A member must already exist: there is nothing to hand artwork to before
 * somebody has used the bot at least once, and inventing a row here would
 * create a claim its owner could never reach.
 */
export async function requireRecipient(
  prisma: PrismaClient,
  to: MemberReference,
): Promise<Recipient> {
  const found =
    to.kind === 'handle'
      ? await findMemberByHandle(prisma, to.platform, to.handle)
      : await findMemberByIdentity(prisma, to.platform, to.externalId).then((member) =>
          member === null ? null : { ...member, externalId: to.externalId, handle: null },
        );

  if (found === null) {
    const shown =
      to.kind === 'handle' ? `${to.platform}:@${to.handle}` : `${to.platform}:${to.externalId}`;
    throw new CliError(
      `no member matches "${shown}". They must have used the bot at least once first.`,
    );
  }

  return {
    id: found.id,
    label:
      found.handle === null
        ? `${to.platform}:${found.externalId}`
        : `${to.platform}:@${found.handle}`,
  };
}
