import { parseEligibilityRule } from '../../../core/ports.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { optionalFlag, requireInt, requireSlug } from '../args.js';
import type { ParsedArgs } from '../args.js';
import { CliError } from '../errors.js';
import { keyValue } from '../format.js';
import { requireProject } from '../lookup.js';

/**
 * Binding a project to its community group, and saying who may roll.
 *
 * Both settings were readable long before anything could write them, which
 * made two features look implemented and behave as though they were not:
 * announcements never fired, /verify could never find a project, and every
 * eligibility rule sat at its default of open to all.
 */

/**
 * A Telegram group id.
 *
 * Validated as a number here even though the column is text, because the
 * column is deliberately platform-agnostic and this command is not. A group id
 * that no Telegram API call could ever accept is a binding that silently does
 * nothing, which is the failure this whole command exists to end.
 */
function requireGroupId(args: ParsedArgs, name: string): string {
  const raw = optionalFlag(args, name);
  if (raw === undefined) {
    throw new CliError(`missing --${name}`);
  }

  const trimmed = raw.trim();
  if (!/^-?\d{1,20}$/.test(trimmed)) {
    throw new CliError(
      `--${name} must be a Telegram chat id, e.g. -1001234567890. ` +
        'Add the bot to the group and use a bot such as @getidsbot to read it.',
    );
  }
  return trimmed;
}

/**
 * Binds a project to the group it talks to.
 *
 * One id serves both announcements and /verify. A second column for "the
 * verification group" would be a second thing to keep in step with the first,
 * and a project announcing in one room while verifying against another is not
 * a configuration anybody has asked for.
 */
export async function groupCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
): Promise<number> {
  const slug = requireSlug(args, 'project');
  const project = await requireProject(prisma, slug);

  const detaching = args.switches.has('detach');
  const announcing = args.switches.has('announce');
  const silencing = args.switches.has('silent');

  if (announcing && silencing) {
    throw new CliError('pass either --announce or --silent, not both');
  }

  if (detaching) {
    await prisma.project.update({
      where: { id: project.id },
      data: { announceChannelId: null, announceOnClaim: false },
    });
    write(
      `${project.name} (${slug}) is no longer bound to a group. ` +
        'Announcements are off and /verify will not answer there.\n',
    );
    return 0;
  }

  const existing = await prisma.project.findUnique({
    where: { id: project.id },
    select: { announceChannelId: true, announceOnClaim: true },
  });

  // No flags at all reports rather than changes, so checking a binding cannot
  // alter one by running the wrong command.
  if (optionalFlag(args, 'chat') === undefined && !announcing && !silencing) {
    write(
      `${keyValue([
        ['project', `${project.name} (${slug})`],
        ['group', existing?.announceChannelId ?? '(none)'],
        ['announces claims', existing?.announceOnClaim === true ? 'yes' : 'no'],
        [
          '/verify',
          existing?.announceChannelId === null || existing?.announceChannelId === undefined
            ? 'will not answer — no group bound'
            : 'answers in that group',
        ],
      ])}\n`,
    );
    return 0;
  }

  const chatId =
    optionalFlag(args, 'chat') === undefined
      ? (existing?.announceChannelId ?? null)
      : requireGroupId(args, 'chat');

  if (chatId === null) {
    throw new CliError('no group is bound yet, so pass --chat with the group id');
  }

  const announceOnClaim = announcing
    ? true
    : silencing
      ? false
      : (existing?.announceOnClaim ?? false);

  await prisma.project.update({
    where: { id: project.id },
    data: { announceChannelId: chatId, announceOnClaim },
  });

  write(
    `${keyValue([
      ['project', `${project.name} (${slug})`],
      ['group', chatId],
      ['announces claims', announceOnClaim ? 'yes' : 'no'],
      ['/verify', 'answers in that group'],
    ])}\n\nThe bot must be in that group to announce or verify.\n`,
  );
  return 0;
}

/**
 * Sets who may roll.
 *
 * The rule is written as JSON into a column, and read back through the same
 * parser the bot uses before it is saved — so a rule this command accepts is
 * a rule the bot can enforce. Writing one it could not read would produce a
 * project that refuses everybody, because an unreadable rule fails closed.
 */
export async function eligibilityCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
): Promise<number> {
  const slug = requireSlug(args, 'project');
  const project = await requireProject(prisma, slug);

  const open = args.switches.has('open');
  const groupId = optionalFlag(args, 'in-group');
  const days = optionalFlag(args, 'days');

  if (!open && groupId === undefined) {
    const current = await prisma.project.findUnique({
      where: { id: project.id },
      select: { eligibilityRule: true },
    });
    const rule = parseEligibilityRule(current?.eligibilityRule);

    write(
      `${keyValue([
        ['project', `${project.name} (${slug})`],
        [
          'who may roll',
          rule === null
            ? 'UNREADABLE — nobody can roll until this is fixed'
            : rule.kind === 'open'
              ? 'anybody with the link'
              : rule.kind === 'group-member'
                ? `members of group ${rule.groupId}`
                : `members of group ${rule.groupId} for ${String(rule.minimumDays)}+ days`,
        ],
      ])}\n`,
    );
    return 0;
  }

  if (open && groupId !== undefined) {
    throw new CliError('pass either --open or --in-group, not both');
  }

  const rule = open
    ? { kind: 'open' }
    : days === undefined
      ? { kind: 'group-member', groupId: requireGroupId(args, 'in-group') }
      : {
          kind: 'group-tenure',
          groupId: requireGroupId(args, 'in-group'),
          minimumDays: requireInt(args, 'days', { min: 0, max: 3650 }),
        };

  // Read back through the bot's own parser before it is stored. A rule saved
  // here that the bot cannot read would lock every member out, and finding
  // that out at the drop is finding it out too late.
  if (parseEligibilityRule(rule) === null) {
    throw new CliError(
      'that rule could not be read back by the bot, so it was not saved. This is a bug — please report it.',
    );
  }

  await prisma.project.update({
    where: { id: project.id },
    data: { eligibilityRule: rule },
  });

  const described =
    rule.kind === 'open'
      ? 'anybody with the link'
      : rule.kind === 'group-member'
        ? `members of group ${String(rule.groupId)}`
        : `members of group ${String(rule.groupId)} for ${String(rule.minimumDays)}+ days`;

  write(
    `${keyValue([
      ['project', `${project.name} (${slug})`],
      ['who may roll', described],
    ])}\n${
      rule.kind === 'group-tenure'
        ? '\nTenure counts from when this bot first confirmed somebody in the group,\n' +
          'not from when they joined — Telegram does not report join dates. Anybody\n' +
          'already in the group starts counting today.\n'
        : rule.kind === 'group-member'
          ? '\nThe bot must be in that group, or it cannot check and will refuse everybody.\n'
          : ''
    }`,
  );
  return 0;
}
