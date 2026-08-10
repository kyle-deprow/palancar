import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.terraform/**',
      '**/*.ehpk',
      '**/simulator-screenshots/**'
    ]
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
);
