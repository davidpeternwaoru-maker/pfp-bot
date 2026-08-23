import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'src/generated/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The flat config itself lives outside tsconfig's include set.
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The schema is the source of truth for uniqueness; `any` would let a
      // wrong shape reach it silently.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The layering rule, enforced rather than trusted. Core is the product:
    // rendering, rarity, exclusions, claim rules, database access. It must
    // stay usable by a web or Discord front end, which means it cannot know
    // that Telegram exists. Deleting src/adapters must leave core compiling.
    files: ['src/core/**/*.ts', 'tests/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['grammy', 'grammy/*'],
              message: 'core must not import grammY. Telegram belongs in src/adapters/telegram.',
            },
            {
              group: ['**/adapters/**'],
              message:
                'core must not depend on a front end. Move the shared part into core instead.',
            },
            {
              group: ['**/config/env.js', '**/config/env'],
              message:
                'core takes its inputs as arguments. Read env at the composition root and pass values in.',
            },
          ],
        },
      ],
    },
  },
  {
    // The other half of the layering rule. Adapters may use core, but only
    // through its stated contract: a deep import is how a boundary turns into
    // twenty accidental ones nobody agreed to.
    files: ['src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/core/*/**', '**/core/[a-z]*.js', '!**/core/ports.js'],
              message:
                'import core through core/ports.js. If you need something it does not export, widen the contract there deliberately.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
