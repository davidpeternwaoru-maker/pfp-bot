import { EnvValidationError, loadEnv } from '../../config/env.js';
import { createPrismaClient } from '../../core/db/client.js';
import { createLogger } from '../../logging/logger.js';
import { parseArgv } from './args.js';
import { awardCommand } from './commands/award.js';
import { capacityCommand, exportHoldersCommand, statsCommand } from './commands/inspect.js';
import {
  claimWindowCommand,
  createProjectCommand,
  importTraitsCommand,
} from './commands/manage.js';
import { CliError } from './errors.js';

/**
 * The admin tool.
 *
 * A command line rather than a web panel: these commands are rare, privileged
 * and destructive, and a terminal already has the authentication, the audit
 * trail and the friction that a panel would have to reinvent badly.
 */

const USAGE = `pfp-bot admin

  create-project   --slug <slug> --name <name> --width <px> --height <px> [--mascot <name>]
  import-traits    --project <slug> --dir <path> [--replace] [--yes]
  capacity         --project <slug> --members <expected>
  open-claims      --project <slug> [--opens-at <iso>] [--closes-at <iso>] [--yes]
  close-claims     --project <slug> [--yes]
  award            --issuer <platform:id> --project <slug> --to <platform:id|platform:@handle>
                   --traits 1,2,3 [--yes]
  export-holders   --project <slug> [--out <file.csv>]
  stats            --project <slug>

Trait pack layout: one directory per slot named "<layerOrder>-<slot>",
containing "name.png", "name.tier.png" or "name.tier.weight.png".

Commands that change what members can do ask for confirmation. Pass --yes
only when scripting, and only when you already know what it will do.
`;

async function main(): Promise<number> {
  const args = parseArgv(process.argv.slice(2));
  const write = (text: string): void => {
    process.stdout.write(text);
  };

  if (args.command === undefined || args.switches.has('help')) {
    write(USAGE);
    return args.command === undefined ? 1 : 0;
  }

  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL });
  const prisma = createPrismaClient(env.DATABASE_URL);

  try {
    switch (args.command) {
      case 'create-project':
        return await createProjectCommand(prisma, args, write);

      case 'import-traits':
        return await importTraitsCommand(prisma, args, write, env.TRAIT_ROOT);

      case 'capacity':
        return await capacityCommand(prisma, args, write);

      case 'open-claims':
        return await claimWindowCommand(prisma, args, write, 'open');

      case 'close-claims':
        return await claimWindowCommand(prisma, args, write, 'close');

      case 'award':
        return await awardCommand(prisma, args, write, {
          adminIds: env.ADMIN_IDS,
          traitRoot: env.TRAIT_ROOT,
          claimRoot: env.CLAIM_ROOT,
          logger,
        });

      case 'export-holders':
        return await exportHoldersCommand(prisma, args, write);

      case 'stats':
        return await statsCommand(prisma, args, write);

      default:
        process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  // An operator error is one line they can act on. Anything else is a fault
  // and keeps its stack, because that one somebody needs to debug.
  if (error instanceof CliError || error instanceof EnvValidationError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
