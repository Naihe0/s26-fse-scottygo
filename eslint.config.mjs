import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { files: ['**/*.{ts}'] },
  {
    ignores: [
      '**/*.js',
      '**/*.mjs',
      'private/**',
      'tmp/**',
      '**/.dist',
      '**/.dist-server',
      '**/jest.config.ts',
      '**/types',
      '**/types-not-needed',
      'trials/**/*.ts',
      'tests/trials.tests/**.ts'
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
      'comma-dangle': 'off',
      '@typescript-eslint/comma-dangle': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-dupe-class-members': 'off',
      '@typescript-eslint/indent': 'off'
    }
  }
];
