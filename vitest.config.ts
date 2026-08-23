import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    projects: [
      {
        // Everything the product does, with no front end involved. This suite
        // must keep passing with src/adapters deleted — that is the layering
        // guarantee, expressed as something runnable rather than a convention.
        test: {
          name: 'core',
          environment: 'node',
          include: ['tests/core/**/*.test.ts'],
          // Run core's files one at a time. Two of them open twenty concurrent
          // database transactions each; in parallel they exhaust the
          // connection pool and fail as timeouts, which looks like a
          // correctness bug and is really the test harness competing with
          // itself. Serial is slower and says the same thing every run.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'adapters',
          environment: 'node',
          include: ['tests/adapters/**/*.test.ts'],
        },
      },
      {
        // Startup, configuration and teardown: the composition root, which
        // knows about every layer by definition.
        test: { name: 'app', environment: 'node', include: ['tests/app/**/*.test.ts'] },
      },
    ],
  },
});
