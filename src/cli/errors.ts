/**
 * A problem the operator can fix by changing what they typed. Carries no stack
 * trace to the terminal: a wrong flag should read as one line, not a dump.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
