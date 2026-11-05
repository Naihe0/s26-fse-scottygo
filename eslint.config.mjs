import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { files: ['**/*.ts'] },
  {
    ignores: [
      '**/*.js',
      '**/*.mjs',
      'private/**',
      'ios/mobile/**', // The mobile package uses its own TypeScript configuration.
      'tmp/**',
      '**/.dist',
      '**/jest.config.ts',
      'trials/**/*.ts'
    ]
  },

  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.browser
      },

      ecmaVersion: 'latest',
      sourceType: 'module',

      parserOptions: {
        project: './tsconfig-for-eslint.json'
      }
    },

    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true
        }
      ]
    }
  }
];
