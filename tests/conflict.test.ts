import { describe, expect, it } from 'vitest';
import { classifyClaimConflict } from '../src/claim/conflict.js';

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
    const error = driverError('Member_telegramUserId_key', ['telegramUserId']);
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
