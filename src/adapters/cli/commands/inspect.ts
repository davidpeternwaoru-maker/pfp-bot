import {
  fetchTraitPack,
  findStatsClaims,
  openPoolCapacity,
  openTraits,
  projectStats,
} from '../../../core/ports.js';
import { writeFile } from 'node:fs/promises';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { optionalFlag, requireInt, requireSlug } from '../args.js';
import type { ParsedArgs } from '../args.js';
import { CliError } from '../errors.js';
import { csvRow, isoMinute, keyValue, table } from '../format.js';
import { requireProject } from '../lookup.js';

/** Read-only commands: capacity, stats, and the holder export. */

/**
 * Reports the size of the open pool against how many members are expected.
 *
 * The ten-times rule is about how a drop feels rather than whether it works.
 * At parity, the last members to arrive are choosing from almost nothing, so
 * the roll stops being a roll well before the pool is technically empty.
 */
export async function capacityCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
): Promise<number> {
  const slug = requireSlug(args, 'project');
  const expected = requireInt(args, 'members', { min: 1 });

  const project = await requireProject(prisma, slug);
  const pack = await fetchTraitPack(prisma, project.id);
  const capacity = openPoolCapacity(pack);
  const needed = expected * 10;

  write(
    `${keyValue([
      ['project', `${project.name} (${slug})`],
      ['slots', String(pack.slots.length)],
      ['open combinations', capacity.toLocaleString('en-GB')],
      ['expected members', expected.toLocaleString('en-GB')],
      ['recommended minimum', needed.toLocaleString('en-GB')],
      ['headroom', `${(capacity / expected).toFixed(1)}x expected members`],
    ])}\n\n`,
  );

  write(
    `${table(
      ['slot', 'open options'],
      pack.slots.map((slot) => [slot.slot, String(openTraits(slot).length)]),
      { numeric: [1] },
    )}\n`,
  );

  if (capacity < needed) {
    write(
      `\nWARNING: ${capacity.toLocaleString('en-GB')} combinations is below the ` +
        `${needed.toLocaleString('en-GB')} recommended for ${expected.toLocaleString('en-GB')} members.\n` +
        'Add options to the slots with the fewest, which multiplies fastest.\n',
    );
    // Non-zero so a deployment script checking capacity fails on this.
    return 1;
  }

  write('\nCapacity is comfortable for the expected turnout.\n');
  return 0;
}

export async function statsCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
): Promise<number> {
  const slug = requireSlug(args, 'project');

  const project = await prisma.project.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      status: true,
      claimOpensAt: true,
      claimClosesAt: true,
    },
  });
  if (project === null) {
    throw new CliError(`no project with slug "${slug}"`);
  }

  const pack = await fetchTraitPack(prisma, project.id);
  const capacity = openPoolCapacity(pack);

  // Counting lives in core, and so does the rule that commissions are left out
  // of it. This command only decides how the numbers read.
  const stats = projectStats(await findStatsClaims(prisma, project.id), pack);

  write(
    `${keyValue([
      ['project', `${project.name} (${slug})`],
      ['status', project.status],
      ['opens', project.claimOpensAt === null ? '—' : isoMinute(project.claimOpensAt)],
      ['closes', project.claimClosesAt === null ? '—' : isoMinute(project.claimClosesAt)],
      [
        'claims to date',
        `${String(stats.countedClaims)} (${String(stats.rolledClaims)} rolled, ` +
          `${String(stats.awardedClaims)} awarded)`,
      ],
      ['open pool', `${String(capacity)} combinations`],
      ['remaining', `${String(Math.max(0, capacity - stats.rolledClaims))} unclaimed`],
      ['latest claim', stats.latestClaimAt === null ? '—' : isoMinute(stats.latestClaimAt)],
      // Shown apart from every figure above, because it is in none of them.
      ['commissions', `${String(stats.customClaims)} (excluded from all figures above)`],
    ])}\n`,
  );

  // Keyed on the holdings rather than on the claim count: a project whose only
  // claims are one-of-one pieces has claims but no traits to rank, and printing
  // an empty table with headers reads as a bug rather than as an answer.
  if (stats.traitHoldings.length === 0) {
    write(
      stats.countedClaims === 0
        ? '\nNo claims yet, so no trait rarity to report.\n'
        : '\nNo composited claims yet, so no trait rarity to report.\n',
    );
    return 0;
  }

  write(
    `\nRarest traits actually claimed\n${table(
      ['slot', 'trait', 'held', 'share'],
      stats.traitHoldings
        .slice(0, 10)
        .map((holding) => [
          holding.trait.slot,
          holding.trait.name,
          String(holding.count),
          `${(holding.share * 100).toFixed(1)}%`,
        ]),
      { numeric: [2, 3], indent: '  ' },
    )}\n`,
  );

  return 0;
}

export async function exportHoldersCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
): Promise<number> {
  const slug = requireSlug(args, 'project');
  const outPath = optionalFlag(args, 'out');

  const project = await requireProject(prisma, slug);

  const claims = await prisma.claim.findMany({
    where: { projectId: project.id },
    orderBy: { editionNumber: 'asc' },
    select: {
      editionNumber: true,
      tier: true,
      claimType: true,
      transferable: true,
      combinationHash: true,
      contentHash: true,
      claimedAt: true,
      imagePath: true,
      member: { select: { platform: true, externalId: true, handle: true } },
    },
  });

  // claim_type and transferable are carried here because this export is what a
  // later airdrop or snapshot gets built from. A list that did not say which
  // rows are non-transferable commissions is a list somebody eventually sends
  // a transfer against.
  const lines = [
    csvRow([
      'edition',
      'platform',
      'external_id',
      'handle',
      'claim_type',
      'tier',
      'transferable',
      'claimed_at',
      'combination_hash',
      'content_hash',
      'image_path',
    ]),
    ...claims.map((claim) =>
      csvRow([
        String(claim.editionNumber),
        claim.member.platform,
        claim.member.externalId,
        claim.member.handle ?? '',
        claim.claimType,
        claim.tier,
        String(claim.transferable),
        claim.claimedAt.toISOString(),
        claim.combinationHash,
        claim.contentHash,
        claim.imagePath,
      ]),
    ),
  ];

  const csv = `${lines.join('\n')}\n`;

  if (outPath === undefined) {
    // Straight to stdout so it can be piped, which is the common case.
    write(csv);
    return 0;
  }

  await writeFile(outPath, csv, 'utf8');
  write(`wrote ${String(claims.length)} holders to ${outPath}\n`);
  return 0;
}
