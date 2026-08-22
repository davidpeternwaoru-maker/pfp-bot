import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer reads .env on its own, and the CLI runs outside the app's
// own startup validation — so load the local file here before resolving the URL.
const envFile = resolve(process.cwd(), '.env');
if (process.env['NODE_ENV'] !== 'production' && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // env() throws when unset, so a migration can never run against a fallback.
    url: env('DATABASE_URL'),
  },
});
