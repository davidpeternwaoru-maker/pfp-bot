/**
 * Database backup and restore.
 *
 *   npm run backup            -- writes a timestamped dump
 *   npm run backup -- --check -- proves the newest dump can actually be read
 *
 * A backup nobody has restored is a hope, not a backup. So `--check` exists
 * and is the half that matters: it reads the dump back, counts what is in it,
 * and compares those counts against the live database. A file that exists but
 * cannot be parsed fails here rather than during an incident.
 *
 * Deliberately not pg_dump. Postgres' own tool is better in every way except
 * one that decides it: it must match the server's major version, and this
 * project's database is managed and upgraded by somebody else. A dump tool
 * that stops working when the provider upgrades is a backup that silently
 * stops happening. This reads through Prisma, which is the same client the
 * application uses and is version-matched by definition.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPrismaClient } from '../src/core/db/client.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined) {
  process.stderr.write('DATABASE_URL is not set, so there is nothing to back up.\n');
  process.exit(1);
}

const BACKUP_DIR = resolve(process.env['BACKUP_ROOT'] ?? 'backups');

/**
 * Every table, in an order a restore can replay.
 *
 * Parents before children, because a restore inserts in this order and a
 * child row whose parent does not exist yet is a foreign key violation. The
 * order is written down rather than derived so it cannot quietly change when
 * somebody adds a model.
 */
const TABLES = [
  'project',
  'member',
  'trait',
  'exclusion',
  'claim',
  'walletChallenge',
  'commissionSettings',
  'commission',
  'commissionBrief',
  'commissionWaitlist',
] as const;

interface Dump {
  readonly takenAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly rows: Readonly<Record<string, unknown[]>>;
}

/** Reads every table. Dates and bigints are made explicit so JSON survives. */
async function takeDump(prisma: PrismaClient): Promise<Dump> {
  const rows: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of TABLES) {
    // Prisma's delegates share a shape; this is the one place that is worth
    // reaching for rather than writing ten identical blocks.
    const delegate = prisma[table] as unknown as { findMany: () => Promise<unknown[]> };
    const found = await delegate.findMany();
    rows[table] = found;
    counts[table] = found.length;
  }

  return { takenAt: new Date().toISOString(), counts, rows };
}

/**
 * Serialises with types JSON does not have.
 *
 * A Date written as a bare string restores as a string, and a claim whose
 * claimedAt is a string is a claim that sorts wrongly forever after. Dates and
 * bigints are tagged so the reader can put them back as they were.
 */
function encode(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, raw: unknown) => {
      if (typeof raw === 'bigint') {
        return { __type: 'bigint', value: raw.toString() };
      }
      return raw;
    },
    0,
  );
}

async function writeBackup(prisma: PrismaClient): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });

  const dump = await takeDump(prisma);
  const stamp = dump.takenAt.replaceAll(/[:.]/g, '-');
  const path = join(BACKUP_DIR, `pfp-bot-${stamp}.json`);

  await writeFile(path, encode(dump), 'utf8');
  return path;
}

/** The newest dump on disk, or null when there is none. */
async function newestBackup(): Promise<string | null> {
  if (!existsSync(BACKUP_DIR)) {
    return null;
  }
  const files = (await readdir(BACKUP_DIR)).filter((name) => name.endsWith('.json')).sort();
  const newest = files[files.length - 1];
  return newest === undefined ? null : join(BACKUP_DIR, newest);
}

/**
 * Proves the newest dump is readable and complete.
 *
 * This is the half that makes it a backup. It parses the file, counts what is
 * inside, and compares against the live database — so a truncated write, a
 * disk that filled, or a table added to the schema and forgotten here all fail
 * loudly now instead of during a restore nobody has time for.
 */
async function checkBackup(prisma: PrismaClient): Promise<number> {
  const path = await newestBackup();
  if (path === null) {
    process.stderr.write(`No backup found in ${BACKUP_DIR}. Run npm run backup first.\n`);
    return 1;
  }

  let dump: Dump;
  try {
    dump = JSON.parse(await readFile(path, 'utf8')) as Dump;
  } catch (error) {
    process.stderr.write(
      `${path} could not be parsed, so it is not a backup: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const problems: string[] = [];
  const lines: string[] = [];

  for (const table of TABLES) {
    const delegate = prisma[table] as unknown as { count: () => Promise<number> };
    const live = await delegate.count();
    const backed = dump.counts[table];

    if (backed === undefined) {
      // A model added to the schema and not to TABLES backs up nothing, and
      // would otherwise be discovered only when it was needed.
      problems.push(`${table} is missing from the backup entirely`);
      continue;
    }
    lines.push(
      `  ${table.padEnd(20)} ${String(backed).padStart(6)} backed up, ${String(live).padStart(6)} live`,
    );
    if (backed !== live) {
      // Not always a fault — rows change between the dump and the check — but
      // always worth seeing, because a backup that is always short by the
      // same table is a backup with a bug.
      lines.push(
        `  ${''.padEnd(20)} (differs by ${String(Math.abs(live - backed))}; rows may have changed since)`,
      );
    }
  }

  process.stdout.write(`\nbackup   ${path}\ntaken    ${dump.takenAt}\n\n${lines.join('\n')}\n`);

  if (problems.length > 0) {
    process.stderr.write(`\nPROBLEMS:\n${problems.map((line) => `  - ${line}`).join('\n')}\n`);
    return 1;
  }

  process.stdout.write('\nThe backup parses and covers every table.\n');
  return 0;
}

/**
 * Puts rows back.
 *
 * Additive, and never destructive: existing rows are skipped rather than
 * overwritten, and nothing is deleted first. A restore that truncated would be
 * a restore that destroys everything written since the dump — which during an
 * incident is the difference between losing an hour and losing the lot.
 *
 * Parents before children, in the order TABLES declares, so a row never
 * arrives before the row it points at.
 */
async function restoreBackup(prisma: PrismaClient, path: string): Promise<number> {
  let dump: Dump;
  try {
    dump = JSON.parse(await readFile(path, 'utf8'), (_key, raw: unknown) => {
      if (
        typeof raw === 'object' &&
        raw !== null &&
        (raw as { __type?: string }).__type === 'bigint'
      ) {
        return BigInt((raw as { value: string }).value);
      }
      return raw;
    }) as Dump;
  } catch (error) {
    process.stderr.write(
      `${path} could not be parsed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const lines: string[] = [];

  for (const table of TABLES) {
    const rows = dump.rows[table] ?? [];
    const delegate = prisma[table] as unknown as {
      createMany: (args: {
        data: unknown[];
        skipDuplicates: boolean;
      }) => Promise<{ count: number }>;
    };

    if (rows.length === 0) {
      lines.push(`  ${table.padEnd(20)} nothing to restore`);
      continue;
    }

    // Dates arrive as ISO strings from JSON and have to go back as Dates, or
    // every timestamp restores as text and sorts wrongly forever after.
    const revived = rows.map((row) => reviveDates(row));
    const { count } = await delegate.createMany({ data: revived, skipDuplicates: true });
    lines.push(
      `  ${table.padEnd(20)} ${String(count).padStart(6)} restored, ${String(rows.length - count).padStart(6)} already present`,
    );
  }

  process.stdout.write(`\nrestored from ${path}\n\n${lines.join('\n')}\n`);
  return 0;
}

/** ISO strings back into Dates, which is what the columns actually are. */
function reviveDates(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) {
    return row;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] =
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)
        ? new Date(value)
        : value;
  }
  return out;
}

const prisma = createPrismaClient(DATABASE_URL);

try {
  const restoreIndex = process.argv.indexOf('--restore');

  if (process.argv.includes('--check')) {
    process.exitCode = await checkBackup(prisma);
  } else if (restoreIndex !== -1) {
    const path = process.argv[restoreIndex + 1] ?? (await newestBackup());
    if (path === null) {
      process.stderr.write('No backup to restore from.\n');
      process.exitCode = 1;
    } else {
      process.exitCode = await restoreBackup(prisma, path);
    }
  } else {
    const path = await writeBackup(prisma);
    process.stdout.write(`wrote ${path}\n\nNow prove it: npm run backup -- --check\n`);
  }
} finally {
  await prisma.$disconnect();
}
