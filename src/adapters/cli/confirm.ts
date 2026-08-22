import { createInterface } from 'node:readline/promises';
import { CliError } from './errors.js';

/**
 * The gate in front of anything that changes live state.
 *
 * Typing the project's own slug rather than "y" is deliberate: it is the
 * difference between confirming and reflexively agreeing, and it makes it
 * impossible to confirm the wrong project by muscle memory.
 */

export interface ConfirmRequest {
  readonly summary: string;
  /** What the operator must type back, normally the project slug. */
  readonly expect: string;
  readonly assumeYes: boolean;
  readonly input?: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly write?: (text: string) => void;
}

export async function confirmDestructive(request: ConfirmRequest): Promise<void> {
  const write = request.write ?? ((text: string) => process.stdout.write(text));
  const input = request.input ?? process.stdin;

  if (request.assumeYes) {
    write(`${request.summary}\nconfirmed by --yes\n`);
    return;
  }

  // Fail closed. A non-interactive shell cannot answer, so it must not be
  // treated as having answered yes.
  if (input.isTTY !== true) {
    throw new CliError(
      `${request.summary}\nrefusing to continue without confirmation. ` +
        'Run this in a terminal, or pass --yes if you are scripting it.',
    );
  }

  const rl = createInterface({ input, output: process.stdout });
  try {
    write(`${request.summary}\n`);
    const answer = await rl.question(`type "${request.expect}" to continue: `);
    if (answer.trim() !== request.expect) {
      throw new CliError('cancelled — nothing was changed');
    }
  } finally {
    rl.close();
  }
}
