import type { Logger } from '../../logging/logger.js';
import type { PlatformIdentity } from './args.js';
import { CliError } from './errors.js';

/**
 * Who may put a permanent claim in somebody's collection.
 *
 * An allowlist of platform-qualified ids in ADMIN_IDS, e.g.
 * "telegram:8853090779". There is deliberately no password: a shared secret in
 * an operator's shell history is worse than a list of ids in the environment,
 * and these are already the identities the product understands.
 *
 * Shared by every issuing command rather than restated in each, so a new one
 * cannot ship with a subtly weaker version of this check.
 */
export function requireAdmin(
  issuer: PlatformIdentity,
  adminIds: readonly PlatformIdentity[],
  action: string,
  project: string,
  logger: Logger,
): string {
  const label = `${issuer.platform}:${issuer.externalId}`;

  // Fail closed, and before anything is read from the database.
  if (adminIds.length === 0) {
    throw new CliError(
      `ADMIN_IDS is empty, so nobody is authorised to ${action}. Set it and retry.`,
    );
  }

  // Both halves must match: an id that is an admin on one platform is somebody
  // else entirely on another.
  const authorised = adminIds.some(
    (admin) => admin.platform === issuer.platform && admin.externalId === issuer.externalId,
  );
  if (!authorised) {
    logger.warn(`${action}.refused`, { issuer: label, project });
    throw new CliError(`${label} is not in ADMIN_IDS`);
  }

  return label;
}
