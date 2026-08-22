/**
 * Works out which unique constraint a failed claim hit.
 *
 * The three constraints mean three completely different things to a member —
 * somebody beat you to this artwork, you already hold one, or the edition
 * counter raced — so they must never be collapsed into one error. Anything
 * this cannot identify is returned as null and must be treated as unexpected,
 * never retried on the assumption it was a conflict.
 *
 * The shapes below were taken from the real driver rather than the docs:
 * Prisma 7's pg adapter does not populate `meta.target`, it nests the
 * constraint under `meta.driverAdapterError.cause`. `meta.target` is still
 * matched as well, so a future adapter change degrades to working rather than
 * to silently classifying nothing.
 */

export type ClaimConflict = 'combination' | 'member' | 'edition';

const UNIQUE_VIOLATION = 'P2002';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Postgres quotes identifiers in the constraint payload; compare unquoted. */
function unquote(value: string): string {
  return value.replaceAll('"', '');
}

/** Every field name and constraint name the error mentions, lowercased. */
function conflictTokens(error: Record<string, unknown>): string[] {
  const tokens: string[] = [];

  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      tokens.push(unquote(value).toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }
    }
  };

  const meta = error['meta'];
  if (!isRecord(meta)) {
    return tokens;
  }

  // The documented shape, still used by Prisma's own engines.
  collect(meta['target']);

  const adapterError = meta['driverAdapterError'];
  if (isRecord(adapterError)) {
    const cause = adapterError['cause'];
    if (isRecord(cause)) {
      collect(cause['originalMessage']);
      const constraint = cause['constraint'];
      if (isRecord(constraint)) {
        collect(constraint['fields']);
        collect(constraint['index']);
      }
    }
  }

  return tokens;
}

export function classifyClaimConflict(error: unknown): ClaimConflict | null {
  if (!isRecord(error) || error['code'] !== UNIQUE_VIOLATION) {
    return null;
  }

  const tokens = conflictTokens(error);
  const mentions = (needle: string): boolean =>
    tokens.some((token) => token.includes(needle.toLowerCase()));

  // Checked most specific first: the constraint name contains the field names,
  // so a message naming Claim_projectId_editionNumber_key would also match a
  // looser test for projectId.
  if (mentions('combinationHash')) {
    return 'combination';
  }
  if (mentions('editionNumber')) {
    return 'edition';
  }
  if (mentions('memberId')) {
    return 'member';
  }

  return null;
}
