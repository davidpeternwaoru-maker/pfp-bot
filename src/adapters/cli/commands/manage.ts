import {
  NONE_TRAIT_NAME,
  TraitImageError,
  ensureNoneImage,
  loadTraitImage,
  resolveWithinRoot,
} from '../../../core/ports.js';
import type { TraitTier } from '../../../core/ports.js';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import {
  optionalDate,
  optionalFlag,
  optionalNameList,
  requireFlag,
  requireInt,
  requireSlug,
} from '../args.js';
import type { ParsedArgs } from '../args.js';
import { confirmDestructive } from '../confirm.js';
import { CliError } from '../errors.js';
import { isoMinute, keyValue, table } from '../format.js';
import { requireProject } from '../lookup.js';

/** Commands that write: project creation, trait import, claim window. */

/** Directories are named "<layerOrder>-<slot>", matching the render engine. */
const SLOT_DIR = /^(\d+)-([a-z0-9-]+)$/;

/** A trait file may declare tier and weight: "name.tier.weight.png". */
const TRAIT_FILE = /^([A-Za-z0-9_-]+?)(?:\.(open|gated|legendary))?(?:\.(\d+))?\.png$/;

const MAX_CANVAS_PIXELS = 4096;

export async function createProjectCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
): Promise<number> {
  const slug = requireSlug(args, 'slug');
  const name = requireFlag(args, 'name');
  const width = requireInt(args, 'width', { min: 1, max: MAX_CANVAS_PIXELS });
  const height = requireInt(args, 'height', { min: 1, max: MAX_CANVAS_PIXELS });
  const mascot = optionalFlag(args, 'mascot') ?? name;

  // Checked before writing so the operator gets "that slug is taken" rather
  // than a constraint violation from the driver.
  const existing = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  if (existing !== null) {
    throw new CliError(`slug "${slug}" is already used by another project`);
  }

  const project = await prisma.project.create({
    data: {
      name,
      slug,
      mascotName: mascot,
      // Always draft. A project that went live the moment it was created would
      // be open to members before it had a single trait.
      status: 'draft',
      canvasWidth: width,
      canvasHeight: height,
    },
    select: { id: true },
  });

  write(
    `${keyValue([
      ['created', `${name} (${slug})`],
      ['id', String(project.id)],
      ['canvas', `${String(width)}x${String(height)}`],
      ['status', 'draft'],
    ])}\n\nNext: import a trait pack, then open the claim window.\n`,
  );
  return 0;
}

interface ScannedTrait {
  readonly slot: string;
  readonly layerOrder: number;
  readonly name: string;
  readonly tier: TraitTier;
  readonly rarityWeight: number;
  readonly imagePath: string;
}

interface ScanFailure {
  readonly path: string;
  readonly reason: string;
}

/**
 * Walks the pack directory, validating every image.
 *
 * Collects failures rather than stopping at the first: an operator fixing a
 * 200-file pack needs the whole list, not one error per run.
 */
async function scanPack(
  root: string,
  packDir: string,
  canvas: { width: number; height: number },
): Promise<{ traits: ScannedTrait[]; failures: ScanFailure[] }> {
  const traits: ScannedTrait[] = [];
  const failures: ScanFailure[] = [];

  const entries = await readdir(packDir, { withFileTypes: true });
  const slotDirs = entries.filter((entry) => entry.isDirectory());

  if (slotDirs.length === 0) {
    throw new CliError(`${packDir} contains no slot directories named "<layerOrder>-<slot>"`);
  }

  for (const dir of slotDirs) {
    const match = SLOT_DIR.exec(dir.name);
    if (match === null) {
      failures.push({
        path: dir.name,
        reason: 'directory is not named "<layerOrder>-<slot>", e.g. 10-body',
      });
      continue;
    }

    const layerOrder = Number(match[1]);
    const slot = match[2] ?? dir.name;
    const files = (await readdir(join(packDir, dir.name))).sort();

    for (const file of files) {
      const fileMatch = TRAIT_FILE.exec(file);
      if (fileMatch === null) {
        failures.push({
          path: `${dir.name}/${file}`,
          reason: 'filename must be "name.png", "name.tier.png" or "name.tier.weight.png"',
        });
        continue;
      }

      const relativePath = relative(root, join(packDir, dir.name, file))
        .split(sep)
        .join('/');

      try {
        // The real loader, so the import applies exactly the checks a render
        // will later apply. A pack that imports but cannot render is worthless.
        await loadTraitImage(relativePath, { canvas, root });
      } catch (error) {
        failures.push({
          path: `${dir.name}/${file}`,
          reason: error instanceof TraitImageError ? error.message : String(error),
        });
        continue;
      }

      traits.push({
        slot,
        layerOrder,
        name: fileMatch[1] ?? file,
        tier: (fileMatch[2] as TraitTier | undefined) ?? 'open',
        rarityWeight: fileMatch[3] === undefined ? 1 : Number(fileMatch[3]),
        imagePath: relativePath,
      });
    }
  }

  return { traits, failures };
}

export async function importTraitsCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
  traitRoot: string,
): Promise<number> {
  const slug = requireSlug(args, 'project');
  const dir = requireFlag(args, 'dir');

  const project = await requireProject(prisma, slug);
  const canvas = { width: project.canvasWidth, height: project.canvasHeight };

  // The directory is operator input, so it is confined to the configured trait
  // root before anything reads from it.
  const located = await resolveWithinRoot(traitRoot, dir);
  if (!located.ok) {
    throw new CliError(
      located.reason === 'missing'
        ? `--dir "${dir}" does not exist inside the trait root (${traitRoot})`
        : `--dir "${dir}" resolves outside the trait root (${traitRoot})`,
    );
  }

  const info = await stat(located.path);
  if (!info.isDirectory()) {
    throw new CliError(`--dir "${dir}" is not a directory`);
  }

  const realRoot = (await resolveWithinRoot(traitRoot, '.')) as { ok: true; path: string };
  const { traits, failures } = await scanPack(realRoot.path, located.path, canvas);

  if (failures.length > 0) {
    write(
      `${String(failures.length)} file(s) failed validation:\n${table(
        ['file', 'problem'],
        failures.map((failure) => [failure.path, failure.reason]),
        { indent: '  ' },
      )}\n\n`,
    );
    // Nothing is written. A half-imported pack renders wrong for whoever rolls
    // it, and finding out which half was imported is worse than re-running.
    throw new CliError('import cancelled — no traits were written. Fix the files above and retry.');
  }

  if (traits.length === 0) {
    throw new CliError(`no PNG traits found under ${dir}`);
  }

  // Every slot gets a "none" option by default, so a member can choose to have
  // no hat, no chain, no mouth. Added here rather than asked of the operator
  // because a pack missing one in a single slot is a pack where that slot is
  // silently compulsory, and nobody would notice until a member asked why they
  // could not take the hat off.
  //
  // It is an ordinary trait row pointing at a transparent layer. Nothing
  // downstream knows it is special, which is why nothing downstream can get it
  // wrong.
  //
  // --required names the slots carrying base artwork. A background or a body
  // with a "none" option is a slot whose absence renders a hole, so the default
  // has to be overridable — but only deliberately, and only by name.
  const layerOfSlot = new Map(traits.map((trait) => [trait.slot, trait.layerOrder] as const));
  const required = optionalNameList(args, 'required');

  // Checked against the pack rather than accepted as given: a typo would leave
  // a slot optional that the operator believed they had just made compulsory.
  const unknown = required.filter((slot) => !layerOfSlot.has(slot));
  if (unknown.length > 0) {
    throw new CliError(
      `--required names ${unknown.map((slot) => `"${slot}"`).join(', ')}, which ` +
        `${unknown.length === 1 ? 'is not a slot' : 'are not slots'} in this pack. ` +
        `Found: ${[...layerOfSlot.keys()].join(', ')}.`,
    );
  }

  const noneImage = await ensureNoneImage(realRoot.path, canvas);
  const compulsory = new Set(required);

  for (const [slot, layerOrder] of layerOfSlot) {
    if (compulsory.has(slot)) {
      continue;
    }
    // An operator who shipped their own none.png keeps it: a second row would
    // collide on (projectId, slot, name) and fail the whole import.
    const supplied = traits.some((trait) => trait.slot === slot && trait.name === NONE_TRAIT_NAME);
    if (supplied) {
      continue;
    }
    traits.push({
      slot,
      layerOrder,
      name: NONE_TRAIT_NAME,
      // Open tier and weight 1: "none" is an ordinary option in the pool, as
      // likely as any other, and reachable by rolling like any other.
      tier: 'open',
      rarityWeight: 1,
      imagePath: noneImage,
    });
  }

  const existing = await prisma.trait.count({ where: { projectId: project.id } });
  const replace = args.switches.has('replace');

  if (existing > 0 && !replace) {
    throw new CliError(
      `${project.name} already has ${String(existing)} traits. ` +
        'Pass --replace to discard them and import this pack instead.',
    );
  }

  if (replace && existing > 0) {
    const claims = await prisma.claim.count({ where: { projectId: project.id } });
    if (claims > 0) {
      // Replacing traits under existing claims would leave those claims
      // pointing at trait ids that no longer exist, so their artwork could
      // never be re-rendered. That is not recoverable, so it is refused.
      throw new CliError(
        `${project.name} has ${String(claims)} claim(s). Traits cannot be replaced once ` +
          'anybody holds one — their artwork would stop being reproducible.',
      );
    }

    await confirmDestructive({
      summary: `This will delete all ${String(existing)} existing traits for ${project.name}.`,
      expect: slug,
      assumeYes: args.switches.has('yes'),
    });
  }

  const written = await prisma.$transaction(async (tx) => {
    if (replace) {
      await tx.exclusion.deleteMany({ where: { projectId: project.id } });
      await tx.trait.deleteMany({ where: { projectId: project.id } });
    }
    return tx.trait.createMany({
      data: traits.map((trait) => ({ projectId: project.id, ...trait })),
    });
  });

  const bySlot = new Map<string, number>();
  for (const trait of traits) {
    bySlot.set(trait.slot, (bySlot.get(trait.slot) ?? 0) + 1);
  }

  write(
    `imported ${String(written.count)} traits into ${project.name}\n\n${table(
      ['slot', 'options', 'optional'],
      [...bySlot].map(([slot, count]) => [
        slot,
        String(count),
        compulsory.has(slot) ? 'no' : 'yes',
      ]),
      { numeric: [1], indent: '  ' },
    )}\n`,
  );
  return 0;
}

export async function claimWindowCommand(
  prisma: PrismaClient,
  args: ParsedArgs,
  write: (text: string) => void,
  action: 'open' | 'close',
): Promise<number> {
  const slug = requireSlug(args, 'project');
  const opensAt = optionalDate(args, 'opens-at');
  const closesAt = optionalDate(args, 'closes-at');

  if (opensAt !== undefined && closesAt !== undefined && closesAt <= opensAt) {
    throw new CliError('--closes-at must be after --opens-at');
  }

  const project = await prisma.project.findUnique({
    where: { slug },
    select: { id: true, name: true, status: true },
  });
  if (project === null) {
    throw new CliError(`no project with slug "${slug}"`);
  }

  if (action === 'open') {
    const traits = await prisma.trait.count({ where: { projectId: project.id } });
    if (traits === 0) {
      // Fail closed: opening an empty project would greet every member with a
      // render error instead of a roll.
      throw new CliError(`${project.name} has no traits imported yet, so it cannot open`);
    }

    await confirmDestructive({
      summary:
        `This will open ${project.name} to members` +
        `${opensAt === undefined ? ' immediately' : ` from ${isoMinute(opensAt)}`}.`,
      expect: slug,
      assumeYes: args.switches.has('yes'),
    });

    await prisma.project.update({
      where: { id: project.id },
      data: {
        status: 'live',
        claimOpensAt: opensAt ?? null,
        claimClosesAt: closesAt ?? null,
      },
    });

    write(
      `${keyValue([
        ['project', `${project.name} (${slug})`],
        ['status', 'live'],
        ['opens', opensAt === undefined ? 'immediately' : isoMinute(opensAt)],
        ['closes', closesAt === undefined ? 'when closed manually' : isoMinute(closesAt)],
      ])}\n`,
    );
    return 0;
  }

  await confirmDestructive({
    summary: `This will close ${project.name}. No further claims will be possible.`,
    expect: slug,
    assumeYes: args.switches.has('yes'),
  });

  await prisma.project.update({ where: { id: project.id }, data: { status: 'closed' } });
  write(`${project.name} (${slug}) is closed. Existing claims are unaffected.\n`);
  return 0;
}
