import { findCommissionTerms, formatUsdc, payablesReport } from '../../../core/ports.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { optionalFlag, optionalNameList, requireInt, requireSlug } from '../args.js';
import type { ParsedArgs } from '../args.js';
import { CliError } from '../errors.js';
import { isoMinute, keyValue, table } from '../format.js';
import { requireProject } from '../lookup.js';

/**
 * Configuring commissions, and reading what is owed.
 *
 * Settings and accounting live in the terminal while approving lives in
 * Telegram, and the split is deliberate. Approving is a judgement made
 * wherever the operator happens to be, so it wants a phone. Setting a price or
 * reading a payable is deliberate, rare, and wants somewhere with a record of
 * what was typed.
 */

/** A price in USDC, taken as people say it and stored as exact cents. */
function requireUsdcCents(args: ParsedArgs, name: string): number {
  const raw = optionalFlag(args, name);
  if (raw === undefined) {
    throw new CliError(`missing --${name}`);
  }

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (match === null) {
    throw new CliError(`--${name} must be an amount like 50 or 49.99`);
  }
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

/**
 * A percentage as basis points, so 12.5 is expressible.
 *
 * Stored as an integer because a share that rounds is a share somebody
 * eventually argues about.
 */
function requireShareBps(args: ParsedArgs, name: string): number {
  const raw = optionalFlag(args, name) ?? '0';
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (match === null) {
    throw new CliError(`--${name} must be a percentage like 10 or 12.5`);
  }

  const bps = Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  if (bps > 10_000) {
    throw new CliError(`--${name} cannot be more than 100`);
  }
  return bps;
}

export async function commissionSettingsCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
): Promise<number> {
  const slug = requireSlug(args, 'project');
  const project = await requireProject(prisma, slug);

  // With no flags this only reports, so an operator can check terms without
  // any risk of changing them by running the wrong command.
  const changing = ['price', 'capacity', 'share', 'slots', 'mint', 'minimum'].some(
    (flag) => optionalFlag(args, flag) !== undefined,
  );
  const enabling = args.switches.has('enable');
  const disabling = args.switches.has('disable');

  if (!changing && !enabling && !disabling) {
    const terms = await findCommissionTerms(prisma, project.id);
    if (terms === null) {
      write(`${project.name} has no commission settings yet.\n`);
      return 0;
    }
    write(
      `${keyValue([
        ['project', `${project.name} (${slug})`],
        ['commissions', terms.enabled ? 'open' : 'closed'],
        ['price', formatUsdc(terms.priceUsdcCents)],
        ['treasury share', `${(terms.treasuryShareBps / 100).toFixed(2)}%`],
        ['monthly capacity', String(terms.monthlyCapacity)],
        ['eligible slots', terms.eligibleSlots.join(', ') || '(none)'],
        [
          'token gate',
          terms.tokenMint === null ? 'none' : `${terms.tokenMinimum ?? '?'} of ${terms.tokenMint}`,
        ],
      ])}\n`,
    );
    return 0;
  }

  if (enabling && disabling) {
    throw new CliError('pass either --enable or --disable, not both');
  }

  const mint = optionalFlag(args, 'mint');
  const minimum = optionalFlag(args, 'minimum');

  // Both halves or neither. A mint with no threshold gates on nothing, and a
  // threshold with no mint has nothing to measure — either alone is a gate
  // that looks configured and admits everybody.
  if ((mint === undefined) !== (minimum === undefined)) {
    throw new CliError('--mint and --minimum must be given together, or not at all');
  }

  const slots = optionalNameList(args, 'slots');
  if (slots.length > 0) {
    const known = await prisma.trait.findMany({
      where: { projectId: project.id },
      select: { slot: true },
      distinct: ['slot'],
    });
    const names = new Set(known.map((row) => row.slot));
    const unknown = slots.filter((slot) => !names.has(slot));
    // Checked against the pack rather than accepted as typed: a slot nobody
    // can order is a slot that silently accepts no orders.
    if (unknown.length > 0) {
      throw new CliError(
        `--slots names ${unknown.map((slot) => `"${slot}"`).join(', ')}, which this project has no traits for. ` +
          `Found: ${[...names].join(', ') || '(none)'}.`,
      );
    }
  }

  const existing = await findCommissionTerms(prisma, project.id);
  const priceUsdcCents =
    optionalFlag(args, 'price') === undefined
      ? (existing?.priceUsdcCents ?? 0)
      : requireUsdcCents(args, 'price');

  const data = {
    enabled: enabling ? true : disabling ? false : (existing?.enabled ?? false),
    priceUsdcCents,
    treasuryShareBps:
      optionalFlag(args, 'share') === undefined
        ? (existing?.treasuryShareBps ?? 0)
        : requireShareBps(args, 'share'),
    monthlyCapacity:
      optionalFlag(args, 'capacity') === undefined
        ? (existing?.monthlyCapacity ?? 0)
        : requireInt(args, 'capacity', { min: 0 }),
    // Copied rather than passed through: the terms carry a readonly array,
    // and Prisma wants one it may keep.
    eligibleSlots: slots.length > 0 ? [...slots] : [...(existing?.eligibleSlots ?? [])],
    tokenMint: mint ?? existing?.tokenMint ?? null,
    tokenMinimum: minimum ?? existing?.tokenMinimum ?? null,
  };

  // Refused rather than saved half-open: a project open for orders with no
  // price, no capacity or no slot accepts orders nobody can fill.
  if (data.enabled) {
    if (data.priceUsdcCents <= 0) {
      throw new CliError('cannot open commissions with no price. Pass --price.');
    }
    if (data.monthlyCapacity <= 0) {
      throw new CliError('cannot open commissions with no monthly capacity. Pass --capacity.');
    }
    if (data.eligibleSlots.length === 0) {
      throw new CliError('cannot open commissions with no eligible slots. Pass --slots.');
    }
  }

  await prisma.commissionSettings.upsert({
    where: { projectId: project.id },
    create: { projectId: project.id, ...data },
    update: data,
  });

  write(
    `${keyValue([
      ['project', `${project.name} (${slug})`],
      ['commissions', data.enabled ? 'open' : 'closed'],
      ['price', formatUsdc(data.priceUsdcCents)],
      ['treasury share', `${(data.treasuryShareBps / 100).toFixed(2)}%`],
      ['monthly capacity', String(data.monthlyCapacity)],
      ['eligible slots', data.eligibleSlots.join(', ') || '(none)'],
      [
        'token gate',
        data.tokenMint === null ? 'none' : `${data.tokenMinimum ?? '?'} of ${data.tokenMint}`,
      ],
    ])}\n`,
  );
  return 0;
}

/**
 * What is owed, and to whom.
 *
 * Reports and never pays. The plan is explicit that this has to be auditable
 * before it is automatic, and an accounting tool that moved money would be
 * neither.
 */
export async function payablesCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
): Promise<number> {
  const slug = optionalFlag(args, 'project');
  const projectId =
    slug === undefined
      ? undefined
      : (await requireProject(prisma, requireSlug(args, 'project'))).id;

  const report = await payablesReport(prisma, projectId);

  if (report.lines.length === 0) {
    write('Nothing owed to anybody.\n');
    return 0;
  }

  write(
    `${table(
      ['commission', 'project', 'owed to', 'amount', 'since'],
      report.lines.map((line) => [
        String(line.commissionId),
        line.projectName,
        line.kind === 'member-refund' ? 'member (refund)' : 'project (share)',
        line.amount,
        isoMinute(line.since),
      ]),
      { numeric: [0, 3], indent: '  ' },
    )}\n\n`,
  );

  // Never netted. A refund owed to a member and a share owed to a project are
  // different debts to different people, and one combined figure would hide
  // one behind the other.
  write(
    `${keyValue([
      ['owed to projects', formatUsdc(report.treasuryOwedCents)],
      ['owed to members', formatUsdc(report.refundsOwedCents)],
    ])}\n\nNothing here has been paid. This report is the record, not the payment.\n`,
  );
  return 0;
}
