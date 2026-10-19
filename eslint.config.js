import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default defineConfig([
  globalIgnores([
    'node_modules/',
    'dist/',
    '.wrangler/',
    '.superpowers/',
    '.tanstack/',
    'src/routeTree.gen.ts',
    'playwright-report/',
    'test-results/',
    'worker-configuration.d.ts',
    'docs/research/experiments/',
  ]),
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
    extends: [tsPlugin.configs['flat/recommended']],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: [
      'src/browser/**/*.{ts,tsx}',
      'src/routes/**/*.tsx',
      'src/shared/**/*.tsx',
      'src/extensions/**/*.tsx',
      'src/scenarios/**/*.tsx',
      'tests/browser/**/*.{ts,tsx}',
      'tests/unit/**/*.tsx',
    ],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: [
      'src/server/**/*.ts',
      'src/server.ts',
      'src/browser/*.worker.ts',
      'tests/browser/*.worker.ts',
      'tests/workers/**/*.ts',
    ],
    languageOptions: { globals: globals.worker },
  },
  {
    files: [
      '*.{js,mjs,ts}',
      'scripts/**/*.mjs',
      'tests/hmr/**/*.mjs',
      'tests/e2e/**/*.ts',
      'tests/unit/**/*.{ts,tsx}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/browser/**/*.tsx', 'src/scenarios/**/*.tsx', 'src/extensions/**/*.tsx'],
    ignores: ['src/browser/ui/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'JSXOpeningElement[name.type="JSXIdentifier"][name.name=/^(button|input|select|textarea|dialog|label|details|summary)$/]',
          message:
            '应用控件请复用 src/browser/ui 的 shadcn 组件；聊天交互同时组合 assistant-ui 原语。',
        },
      ],
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
]);
