import { describe, expect, it } from 'vitest';
import {
  optionalDate,
  optionalFlag,
  parseArgv,
  requireFlag,
  requireIdList,
  requireInt,
  requireSlug,
  requireIdentity,
  requireMemberReference,
} from '../../../src/adapters/cli/args.js';
import { CliError } from '../../../src/adapters/cli/errors.js';

describe('parseArgv', () => {
  it('reads the command and its flags', () => {
    const args = parseArgv(['stats', '--project', 'my-drop']);
    expect(args.command).toBe('stats');
    expect(args.flags.get('project')).toBe('my-drop');
  });

  it('accepts --key=value as well as --key value', () => {
    const args = parseArgv(['capacity', '--project=my-drop', '--members', '500']);
    expect(args.flags.get('project')).toBe('my-drop');
    expect(args.flags.get('members')).toBe('500');
  });

  it('treats a flag with no value as a switch', () => {
    const args = parseArgv(['import-traits', '--project', 'x', '--replace', '--yes']);
    expect(args.switches.has('replace')).toBe(true);
    expect(args.switches.has('yes')).toBe(true);
    expect(args.flags.get('project')).toBe('x');
  });

  it('does not swallow the next flag as a value', () => {
    const args = parseArgv(['open-claims', '--yes', '--project', 'x']);
    expect(args.switches.has('yes')).toBe(true);
    expect(args.flags.get('project')).toBe('x');
  });

  it('keeps the first bare word as the command', () => {
    expect(parseArgv(['stats', 'extra']).command).toBe('stats');
  });

  it('reports no command when given none', () => {
    expect(parseArgv([]).command).toBeUndefined();
    expect(parseArgv(['--help']).command).toBeUndefined();
  });
});

describe('validation', () => {
  const args = parseArgv([
    'x',
    '--slug',
    'my-drop',
    '--n',
    '42',
    '--ids',
    '3,1,2',
    '--when',
    '2026-09-01T12:00:00Z',
    '--tg',
    '123456789',
  ]);

  it('accepts well-formed input', () => {
    expect(requireSlug(args, 'slug')).toBe('my-drop');
    expect(requireInt(args, 'n')).toBe(42);
    expect(requireIdList(args, 'ids')).toEqual([3, 1, 2]);
    expect(optionalDate(args, 'when')?.toISOString()).toBe('2026-09-01T12:00:00.000Z');
    expect(requireIdentity(parseArgv(['x', '--who', 'telegram:123456789']), 'who')).toEqual({
      platform: 'telegram',
      externalId: '123456789',
    });
  });

  it('names the missing flag rather than failing vaguely', () => {
    expect(() => requireFlag(args, 'absent')).toThrow(/--absent/);
    expect(optionalFlag(args, 'absent')).toBeUndefined();
    expect(optionalDate(args, 'absent')).toBeUndefined();
  });

  it('rejects a slug the bot would refuse to open', () => {
    // A slug the CLI accepts but the deep link parser rejects would create a
    // project nobody could ever reach.
    for (const bad of ['My-Drop', 'my drop', 'my_drop', 'drop!', 'a'.repeat(65)]) {
      expect(() => requireSlug(parseArgv(['x', '--slug', bad]), 'slug')).toThrow(CliError);
    }
  });

  it('rejects numbers that are not whole, or out of range', () => {
    expect(() => requireInt(parseArgv(['x', '--n', '1.5']), 'n')).toThrow(/whole number/);
    expect(() => requireInt(parseArgv(['x', '--n', 'abc']), 'n')).toThrow(/whole number/);
    expect(() => requireInt(parseArgv(['x', '--n', '0']), 'n', { min: 1 })).toThrow(/at least 1/);
    expect(() => requireInt(parseArgv(['x', '--n', '9999']), 'n', { max: 100 })).toThrow(
      /at most 100/,
    );
  });

  it('rejects a malformed id list', () => {
    for (const bad of ['1,,2', '1,x', '0,1', '-3', '1, 2, ']) {
      expect(() => requireIdList(parseArgv(['x', '--ids', bad]), 'ids')).toThrow(CliError);
    }
  });

  it('rejects a repeated id, which would mean two traits from one slot', () => {
    expect(() => requireIdList(parseArgv(['x', '--ids', '4,4']), 'ids')).toThrow(/twice/);
  });

  it('rejects a timestamp it cannot parse instead of guessing', () => {
    expect(() => optionalDate(parseArgv(['x', '--when', 'next tuesday']), 'when')).toThrow(
      /ISO 8601/,
    );
  });

  it('requires an identity to name its platform', () => {
    // A bare number is ambiguous: the same digits are a different person on a
    // different front end, so it is refused rather than assumed to be Telegram.
    for (const bad of ['123456789', '@someone', 'telegram:', 'nope:123', '']) {
      expect(() => requireIdentity(parseArgv(['x', '--who', bad]), 'who')).toThrow(CliError);
    }
  });

  it('accepts an id or a handle as a member reference', () => {
    expect(requireMemberReference(parseArgv(['x', '--to', 'telegram:42']), 'to')).toEqual({
      kind: 'identity',
      platform: 'telegram',
      externalId: '42',
    });
    expect(requireMemberReference(parseArgv(['x', '--to', 'telegram:@someone']), 'to')).toEqual({
      kind: 'handle',
      platform: 'telegram',
      handle: 'someone',
    });
  });

  it('rejects a member reference with no platform', () => {
    for (const bad of ['42', '@someone', 'telegram:@', '']) {
      expect(() => requireMemberReference(parseArgv(['x', '--to', bad]), 'to')).toThrow(CliError);
    }
  });
});
