import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'scripts/',
      'templates/vm-shared/apply-home-jq-transforms.mjs',
      'templates/vm-shared-windows/apply-home-jq-transforms.mjs',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'tests/**/*.mjs', '*.config.ts', '*.config.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
