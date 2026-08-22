import { writeFile } from 'node:fs/promises';
import { fetchTraitPack } from '../../../core/db/trait-pack-repository.js';
import { openPoolCapacity, openTraits } from '../../../core/render/pack.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { optionalFlag, requireInt, requireSlug } from '../args.js';
import type { ParsedArgs } from '../args.js';
import { CliError } from '../errors.js';
import { csvRow, isoMinute, keyValue, table } from '../format.js';

/** Read-only commands: capacity, stats, and the holder export. */

async function projectBySlug(
  prisma: PrismaClient,
  slug: string,
): Promise<{ id: number; name: string }> {
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (project === null) {
    throw new CliError(`no project with slug "${slug}"`);
  }
  return project;
}

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

  const project = await projectBySlug(prisma, slug);
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

  const claims = await prisma.claim.findMany({
    where: { projectId: project.id },
    select: { traitIds: true, tier: true, editionNumber: true, claimedAt: true },
  });

  const open = claims.filter((claim) => claim.tier === 'open').length;
  const awarded = claims.length - open;

  write(
    `${keyValue([
      ['project', `${project.name} (${slug})`],
      ['status', project.status],
      ['opens', project.claimOpensAt === null ? '—' : isoMinute(project.claimOpensAt)],
      ['closes', project.claimClosesAt === null ? '—' : isoMinute(project.claimClosesAt)],
      [
        'claims to date',
        `${String(claims.length)} (${String(open)} rolled, ${String(awarded)} awarded)`,
      ],
      ['open pool', `${String(capacity)} combinations`],
      ['remaining', `${String(Math.max(0, capacity - open))} unclaimed`],
      [
        'latest claim',
        claims.length === 0
          ? '—'
          : isoMinute(
              claims.reduce(
                (latest, claim) => (claim.claimedAt > latest ? claim.claimedAt : latest),
                claims[0]?.claimedAt ?? new Date(0),
              ),
            ),
      ],
    ])}\n`,
  );

  if (claims.length === 0) {
    write('\nNo claims yet, so no trait rarity to report.\n');
    return 0;
  }

  // How often each trait actually appears in a claim, which is not the same as
  // its configured weight: exclusions and member choice both bend the outcome.
  const held = new Map<number, number>();
  for (const claim of claims) {
    for (const id of claim.traitIds) {
      held.set(id, (held.get(id) ?? 0) + 1);
    }
  }

  const byId = new Map(
    pack.slots.flatMap((slot) => slot.traits.map((trait) => [trait.id, trait] as const)),
  );

  const rarest = [...held.entries()]
    .map(([id, count]) => ({ trait: byId.get(id), count }))
    .filter(
      (entry): entry is { trait: NonNullable<typeof entry.trait>; count: number } =>
        entry.trait !== undefined,
    )
    .sort((a, b) => a.count - b.count || a.trait.id - b.trait.id)
    .slice(0, 10);

  write(
    `\nRarest traits actually claimed\n${table(
      ['slot', 'trait', 'held', 'share'],
      rarest.map((entry) => [
        entry.trait.slot,
        entry.trait.name,
        String(entry.count),
        `${((entry.count / claims.length) * 100).toFixed(1)}%`,
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

  const project = await projectBySlug(prisma, slug);

  const claims = await prisma.claim.findMany({
    where: { projectId: project.id },
    orderBy: { editionNumber: 'asc' },
    select: {
      editionNumber: true,
      tier: true,
      combinationHash: true,
      contentHash: true,
      claimedAt: true,
      imagePath: true,
      member: { select: { telegramUserId: true, username: true } },
    },
  });

  const lines = [
    csvRow([
      'edition',
      'telegram_user_id',
      'username',
      'tier',
      'claimed_at',
      'combination_hash',
      'content_hash',
      'image_path',
    ]),
    ...claims.map((claim) =>
      csvRow([
        String(claim.editionNumber),
        String(claim.member.telegramUserId),
        claim.member.username ?? '',
        claim.tier,
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
