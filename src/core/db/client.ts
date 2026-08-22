import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Prisma 7 talks to Postgres through a driver adapter, so the connection URL is
 * supplied here rather than read from the schema. Taking it as an argument
 * keeps env access confined to the config module.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
