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
        test: { name: 'core', environment: 'node', include: ['tests/core/**/*.test.ts'] },
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
