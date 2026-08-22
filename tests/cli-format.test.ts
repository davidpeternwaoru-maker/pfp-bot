import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, keyValue, table } from '../src/cli/format.js';
import { confirmDestructive } from '../src/cli/confirm.js';
import { CliError } from '../src/cli/errors.js';
import { resolveWithinRoot } from '../src/fs/within-root.js';
import { makeTempRoot } from './helpers/fixtures.js';

describe('table', () => {
  it('aligns columns to the widest cell, header included', () => {
    const output = table(
      ['slot', 'options'],
      [
        ['background', '3'],
        ['hat', '12'],
      ],
      { numeric: [1] },
    );
    const lines = output.split('\n');

    expect(lines[0]).toBe('slot        options');
    expect(lines[1]).toBe('----------  -------');
    // Numbers right-aligned so they compare by eye.
    expect(lines[2]).toBe('background        3');
    expect(lines[3]).toBe('hat              12');
  });

  it('leaves no trailing whitespace, which would show up in a pipe', () => {
    const output = table(['a', 'bbbb'], [['aaaa', 'b']]);
    for (const line of output.split('\n')) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

describe('keyValue', () => {
  it('pads keys so values start in one column', () => {
    const output = keyValue([
      ['project', 'Drop'],
      ['status', 'live'],
    ]);
    expect(output).toBe('project  Drop\nstatus   live');
  });
});

describe('csv', () => {
  it('leaves ordinary values alone', () => {
    expect(csvCell('someone')).toBe('someone');
    expect(csvRow(['1', 'someone', 'open'])).toBe('1,someone,open');
  });

  it('quotes and escapes anything that would break a row', () => {
    // Project and trait names are operator-supplied, so a comma or a quote in
    // one must not silently corrupt a holder list somebody re-imports.
    expect(csvCell('Drop, The Second')).toBe('"Drop, The Second"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });
});

describe('confirmDestructive', () => {
  it('refuses when it cannot ask, rather than assuming yes', async () => {
    // A cron job or a piped shell has no way to answer, so it must not count
    // as having answered.
    await expect(
      confirmDestructive({
        summary: 'This will close the drop.',
        expect: 'my-drop',
        assumeYes: false,
        input: { isTTY: false } as NodeJS.ReadableStream & { isTTY?: boolean },
        write: () => undefined,
      }),
    ).rejects.toThrow(/refusing to continue without confirmation/);
  });

  it('proceeds when --yes was passed deliberately', async () => {
    const written: string[] = [];
    await expect(
      confirmDestructive({
        summary: 'This will close the drop.',
        expect: 'my-drop',
        assumeYes: true,
        write: (text) => written.push(text),
      }),
    ).resolves.toBeUndefined();

    expect(written.join('')).toContain('confirmed by --yes');
  });
});

describe('resolveWithinRoot', () => {
  it('accepts a path inside the root', async () => {
    const root = await makeTempRoot();
    await writeFile(join(root, 'a.png'), 'x');

    const result = await resolveWithinRoot(root, 'a.png');
    expect(result.ok).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  it('refuses traversal out of the root', async () => {
    const root = await makeTempRoot();
    for (const escape of ['../secret', '../../etc/passwd']) {
      const result = await resolveWithinRoot(root, escape);
      expect(result).toEqual({ ok: false, reason: 'escapes-root' });
    }
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an absolute path pointing elsewhere', async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot();
    await writeFile(join(outside, 'secret.png'), 'x');

    const result = await resolveWithinRoot(root, join(outside, 'secret.png'));
    expect(result.ok).toBe(false);

    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reports a missing file distinctly from an escape', async () => {
    const root = await makeTempRoot();
    expect(await resolveWithinRoot(root, 'nope.png')).toEqual({ ok: false, reason: 'missing' });
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a link that leaves the root', async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot();
    await writeFile(join(outside, 'secret.png'), 'x');

    let linked = false;
    try {
      await symlink(outside, join(root, 'escape'), 'junction');
      linked = true;
    } catch {
      // Some platforms refuse links entirely; the traversal cases above still
      // cover containment.
    }

    if (linked) {
      const result = await resolveWithinRoot(root, 'escape/secret.png');
      expect(result).toEqual({ ok: false, reason: 'links-outside' });
    }

    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
});

describe('CliError', () => {
  it('is identifiable so the entry point can print it without a stack', () => {
    const error = new CliError('missing --project');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CliError');
  });
});
