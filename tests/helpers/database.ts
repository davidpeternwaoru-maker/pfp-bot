import type { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Fails fast, and accurately, when the database is not answering.
 *
 * The tests that need real PostgreSQL open twenty concurrent transactions. If
 * the database is slow or unreachable those transactions time out one by one,
 * and the run ends two minutes later with "Hook timed out" — which reads like
 * the code is broken when nothing is wrong with it. Worse, run under the
 * layering check, the same failure reads as "core does not stand on its own".
 *
 * A single cheap query up front turns that into one honest sentence.
 */

/** Generous next to a healthy round trip, tight next to a 120s hook timeout. */
const RESPONSIVE_BUDGET_MS = 5_000;

export async function assertDatabaseResponsive(
  prisma: PrismaClient,
  budgetMs: number = RESPONSIVE_BUDGET_MS,
): Promise<void> {
  const started = Date.now();

  const ping = prisma.$queryRaw`SELECT 1`.then(() => 'ok' as const);
  const expiry = new Promise<'slow'>((resolve) => {
    setTimeout(() => {
      resolve('slow');
    }, budgetMs).unref();
  });

  let outcome: 'ok' | 'slow';
  try {
    outcome = await Promise.race([ping, expiry]);
  } catch (error) {
    throw new Error(
      `Database unreachable, so the tests that prove concurrency cannot run: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Check DATABASE_URL and that the database is awake, then re-run. ` +
        `This is not a code failure.`,
      { cause: error },
    );
  }

  if (outcome === 'slow') {
    throw new Error(
      `Database took over ${String(budgetMs)}ms to answer SELECT 1, so the concurrency ` +
        `tests would time out rather than tell you anything. The database is throttled, ` +
        `suspended, or overloaded — wake it or wait, then re-run. This is not a code failure.`,
    );
  }

  const elapsed = Date.now() - started;
  if (elapsed > 1_000) {
    process.stderr.write(
      `[tests] database answered in ${String(elapsed)}ms — slower than usual, timings may be noisy\n`,
    );
  }
}
