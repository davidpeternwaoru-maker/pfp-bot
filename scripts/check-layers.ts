/**
 * Proves the layering guarantee instead of trusting it.
 *
 * Moves src/adapters and its tests out of the tree, compiles core on its own,
 * runs the core suite, and puts everything back. If a front end ever becomes
 * load-bearing for the product, this is what says so — a lint rule catches a
 * bad import, but only this catches core quietly needing an adapter to work.
 *
 *   npm run check:layers
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.cwd();
const PARKED = resolve(ROOT, '..', '.pfp-layer-check');

/** Everything that is a front end, or exists only to wire one up. */
const MOVES = [
  ['src/adapters', 'src-adapters'],
  ['tests/adapters', 'tests-adapters'],
  ['tests/app', 'tests-app'],
  ['src/index.ts', 'index.ts'],
  ['scripts', 'scripts'],
] as const;

function park(): void {
  mkdirSync(PARKED, { recursive: true });
  for (const [from, to] of MOVES) {
    const source = join(ROOT, from);
    if (existsSync(source)) {
      renameSync(source, join(PARKED, to));
    }
  }
}

function restore(): void {
  for (const [from, to] of MOVES) {
    const parked = join(PARKED, to);
    if (existsSync(parked)) {
      renameSync(parked, join(ROOT, from));
    }
  }
  rmSync(PARKED, { recursive: true, force: true });
}

/**
 * Runs a local tool through node directly rather than through npx.
 *
 * Node refuses to spawn a .cmd shim without a shell, and turning the shell on
 * would mean these arguments get parsed twice. Resolving the tool's own entry
 * point avoids both problems and behaves the same on every platform.
 */
function run(toolEntry: string, args: readonly string[]): void {
  execFileSync(process.execPath, [toolEntry, ...args], { stdio: 'inherit' });
}

const require_ = createRequire(import.meta.url);
const TSC = require_.resolve('typescript/bin/tsc');
const VITEST = join(dirname(require_.resolve('vitest/package.json')), 'vitest.mjs');

/**
 * Which half failed matters, and conflating them misleads.
 *
 * Compilation is the layering question: if core cannot build with no front end
 * present, the layers are wrong. The test run is a different question — a
 * database that is asleep fails it while saying nothing about structure, and
 * reporting that as "core does not stand on its own" sends someone hunting an
 * architectural problem that does not exist.
 */
let failedStage: 'compile' | 'tests' | undefined;

park();
try {
  process.stdout.write('\n--- core, with every adapter removed ---\n\n');
  try {
    run(TSC, ['--noEmit', '-p', 'tsconfig.core.json']);
  } catch {
    failedStage = 'compile';
  }
  if (failedStage === undefined) {
    try {
      run(VITEST, ['run', '--project', 'core']);
    } catch {
      failedStage = 'tests';
    }
  }
} finally {
  // Restored even on failure: leaving the tree gutted because a check failed
  // would be a far worse outcome than the failure itself.
  restore();
}

if (failedStage === 'compile') {
  process.stderr.write(
    '\nLAYERING FAILURE: core does not compile with the adapters removed.\n' +
      'Something in core is reaching for a front end. See the errors above.\n',
  );
  process.exit(1);
}

if (failedStage === 'tests') {
  process.stderr.write(
    '\nLayering holds: core compiled with no front end present.\n' +
      'Its tests then failed, which is a correctness or environment problem —\n' +
      'a throttled or sleeping database fails here and means nothing about layers.\n',
  );
  process.exit(1);
}

process.stdout.write('\ncore compiles and passes its tests with no front end present\n');
