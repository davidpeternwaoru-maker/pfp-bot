import { describe, expect, it } from 'vitest';
import { classifyClaimConflict } from '../../src/core/claim/conflict.js';

/**
 * These payloads were captured from Prisma 7 running against the real
 * PostgreSQL through the pg adapter, not written from the documentation. The
 * adapter does not populate `meta.target`, and a classifier built on the
 * documented shape would silently match nothing — turning every conflict into
 * an unexpected error and every losing claimant into a crash.
 */
function driverError(constraintName: string, fields: readonly string[]): unknown {
  return {
    name: 'PrismaClientKnownRequestError',
    code: 'P2002',
    meta: {
      modelName: 'Claim',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
          kind: 'UniqueConstraintViolation',
          constraint: { fields: fields.map((field) => `"${field}"`) },
        },
      },
    },
  };
}

describe('classifyClaimConflict', () => {
  it('identifies a contested combination', () => {
    const error = driverError('Claim_projectId_combinationHash_key', [
      'projectId',
      'combinationHash',
    ]);
    expect(classifyClaimConflict(error)).toBe('combination');
  });

  it('identifies a member who already holds a claim', () => {
    const error = driverError('Claim_projectId_memberId_key', ['projectId', 'memberId']);
    expect(classifyClaimConflict(error)).toBe('member');
  });

  it('identifies an edition number collision', () => {
    const error = driverError('Claim_projectId_editionNumber_key', ['projectId', 'editionNumber']);
    expect(classifyClaimConflict(error)).toBe('edition');
  });

  it('does not mistake an edition collision for a member conflict', () => {
    // Both constraint names contain "projectId", so a loose match would tie.
    const error = driverError('Claim_projectId_editionNumber_key', ['projectId', 'editionNumber']);
    expect(classifyClaimConflict(error)).not.toBe('member');
  });

  it('still works if a future adapter populates the documented meta.target', () => {
    const error = {
      code: 'P2002',
      meta: { target: ['projectId', 'combinationHash'] },
    };
    expect(classifyClaimConflict(error)).toBe('combination');
  });

  it('returns null for anything it cannot identify, so it is never retried blindly', () => {
    expect(classifyClaimConflict(null)).toBeNull();
    expect(classifyClaimConflict(undefined)).toBeNull();
    expect(classifyClaimConflict(new Error('connection reset'))).toBeNull();
    expect(classifyClaimConflict({ code: 'P2003' })).toBeNull();
    expect(classifyClaimConflict({ code: 'P2002', meta: {} })).toBeNull();
    expect(classifyClaimConflict({ code: 'P2002' })).toBeNull();
  });

  it('does not classify a unique violation on some other table as a claim conflict', () => {
    const error = driverError('Member_platform_externalId_key', ['platform', 'externalId']);
    expect(classifyClaimConflict(error)).toBeNull();
  });

  it('ignores a non-unique error even when it mentions a claim column', () => {
    const error = {
      code: 'P2025',
      meta: { cause: 'Record to update not found: combinationHash' },
    };
    expect(classifyClaimConflict(error)).toBeNull();
  });
});

/**
 * The same collision reported through $queryRaw. Prisma labels a raw failure
 * P2010 rather than P2002, while the driver payload underneath is identical.
 * Captured from the real database after the insert became a raw statement —
 * gating on P2002 alone had silently stopped classifying anything.
 */
function rawDriverError(constraintName: string, fields: readonly string[]): unknown {
  return {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    message: `Invalid \`prisma.$queryRaw()\` invocation: Raw query failed. Code: \`23505\`. Message: \`duplicate key value violates unique constraint "${constraintName}"\``,
    meta: {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
          kind: 'UniqueConstraintViolation',
          constraint: { fields: fields.map((field) => `"${field}"`) },
        },
      },
    },
  };
}

describe('classifyClaimConflict, raw query path', () => {
  it('identifies a contested combination reported as P2010', () => {
    expect(
      classifyClaimConflict(
        rawDriverError('Claim_projectId_combinationHash_key', ['projectId', 'combinationHash']),
      ),
    ).toBe('combination');
  });

  it('identifies the scoped one-open-claim index', () => {
    expect(
      classifyClaimConflict(
        rawDriverError('Claim_projectId_openClaimMemberId_key', ['projectId', 'openClaimMemberId']),
      ),
    ).toBe('member');
  });

  it('identifies an edition collision reported as P2010', () => {
    expect(
      classifyClaimConflict(
        rawDriverError('Claim_projectId_editionNumber_key', ['projectId', 'editionNumber']),
      ),
    ).toBe('edition');
  });

  it('does not treat every raw failure as a conflict', () => {
    // A raw query can fail for reasons that are not collisions at all, and
    // those must stay unexpected rather than being answered with an apology.
    expect(
      classifyClaimConflict({
        code: 'P2010',
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: '42P01',
              originalMessage: 'relation "Claim" does not exist',
              kind: 'UndefinedTable',
            },
          },
        },
      }),
    ).toBeNull();
  });
});
