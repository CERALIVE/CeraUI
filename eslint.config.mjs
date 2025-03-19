import { fixupPluginRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import _import from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dynamic import for the Svelte plugin
const svelteModule = await import('eslint-plugin-svelte');
const svelte = fixupPluginRules(svelteModule.default || svelteModule);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

// Define plugins just once
const plugins = {
  import: fixupPluginRules(_import),
  svelte,
  '@typescript-eslint': fixupPluginRules(typescriptEslint),
  'unused-imports': fixupPluginRules(unusedImports),
};

// Get recommended configs from prettier - properly flattened
const prettierConfig = compat.extends('plugin:prettier/recommended');

export default [
  // Ignore patterns
  {
    ignores: ['**/dist', '**/node_modules', '**/public', '**/*.d.ts'],
  },
  // Base JS config
  js.configs.recommended,
  // TypeScript config - make sure it's properly formatted
  {
    files: ['**/*.ts', '**/*.svelte'],
    rules: { ...typescriptEslint.configs.recommended.rules },
  },
  // Prettier config - spread each item separately to avoid nested arrays
  ...(Array.isArray(prettierConfig) ? prettierConfig : [prettierConfig]),
  // Global settings
  {
    plugins,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.jest,
        ...globals.node,
        NodeJS: 'readonly',
      },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_|^\\$\\$(Props|Events|Slots)$',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
      'import/order': [
        'error',
        {
          alphabetize: { order: 'asc' },
          groups: ['index', 'sibling', 'parent', 'internal', 'external', 'builtin', 'object', 'type'],
        },
      ],
    },
  },
  // TypeScript files
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
  },
  // Svelte files
  {
    files: ['**/*.svelte'],
    rules: {
      ...svelte.configs.recommended.rules,
      'svelte/valid-compile': 'warn',
      'no-undef': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: {
          ts: tsParser,
        },
        extraFileExtensions: ['.svelte'],
        jsx: true,
      },
    },
  },
];
