import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixupPluginRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import _import from 'eslint-plugin-import';
import jsonc from 'eslint-plugin-jsonc';
import promise from 'eslint-plugin-promise';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import jsoncParser from 'jsonc-eslint-parser';
import svelteParser from 'svelte-eslint-parser';

// ============================================================================
// SETUP
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize compatibility layer for traditional ESLint configs
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

// Dynamic import for the Svelte plugin
const svelteModule = await import('eslint-plugin-svelte');
const svelte = fixupPluginRules(svelteModule.default || svelteModule);

// ============================================================================
// PLUGINS REGISTRATION
// ============================================================================

const plugins = {
  import: fixupPluginRules(_import),
  svelte,
  '@typescript-eslint': fixupPluginRules(typescriptEslint),
  'unused-imports': fixupPluginRules(unusedImports),
  '@jsonc': fixupPluginRules(jsonc),
  'simple-import-sort': fixupPluginRules(simpleImportSort),
  unicorn: fixupPluginRules(unicorn),
  promise: fixupPluginRules(promise),
};

// ============================================================================
// SHARED CONFIGURATIONS
// ============================================================================

// Global settings applied only to TypeScript, Svelte, and JSON files
const globalSettings = {
  files: ['**/*.ts', '**/*.svelte', '**/*.json'],
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
  settings: {
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
      },
    },
    'import/cache': true,
    'import/ignore': ['node_modules', '\\.(css|md|svg|json)$'],
  },
  rules: {
    // Disable built-in no-unused-vars rules in favor of unused-imports
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

    // Import sorting and organization
    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',
    'import/first': 'error',
    'import/newline-after-import': 'error',

    // Promise rules
    'promise/param-names': 'error',
    'promise/always-return': 'off',
    'promise/no-return-wrap': 'error',
    'promise/no-new-statics': 'error',
    'promise/no-return-in-finally': 'warn',

    // Unicorn rules - useful subset
    'unicorn/better-regex': 'error',
    'unicorn/error-message': 'error',
    'unicorn/prefer-includes': 'error',
    'unicorn/prefer-string-slice': 'error',
  },
};

// Get Prettier config as a flattened array
const prettierConfig = compat.extends('plugin:prettier/recommended');

// ============================================================================
// LANGUAGE-SPECIFIC CONFIGURATIONS
// ============================================================================

// TypeScript configuration
const typescriptConfig = {
  files: ['**/*.ts'],
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      project: './tsconfig.json',
      projectService: true,
    },
  },
  rules: {
    // TypeScript-specific rules
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/ban-ts-comment': [
      'warn',
      {
        'ts-ignore': 'allow-with-description',
        minimumDescriptionLength: 10,
      },
    ],
    '@typescript-eslint/no-floating-promises': 'warn',
  },
};

// Svelte configuration
const svelteConfig = {
  files: ['**/*.svelte'],
  rules: {
    ...svelte.configs.recommended.rules,
    'svelte/valid-compile': 'warn',
    'no-undef': 'off', // Svelte handles its own globals
    '@typescript-eslint/no-unsafe-member-access': 'off',

    // Svelte 5 specific rules
    'svelte/no-reactive-reassign': 'off', // For $state and other runes
    'svelte/valid-each-key': 'warn', // More relaxed for Svelte 5
    'svelte/no-at-html-tags': 'warn',
    'svelte/no-dom-manipulating': 'warn',
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
};

// JSON configuration
const jsonConfig = {
  files: ['**/*.json'],
  languageOptions: {
    parser: jsoncParser,
  },
  rules: {
    '@jsonc/array-bracket-spacing': ['error', 'never'],
    '@jsonc/object-curly-spacing': ['error', 'always'],
    '@jsonc/key-spacing': ['error', { beforeColon: false, afterColon: true }],
  },
};

// ============================================================================
// EXPORT CONFIGURATION
// ============================================================================

export default [
  // Files and directories to ignore
  {
    ignores: ['**/dist', '**/node_modules', '**/public', '**/*.d.ts', '**/build', '**/coverage', '**/.svelte-kit'],
  },

  // Base JavaScript config (recommended)
  js.configs.recommended,

  // TypeScript config for .ts and .svelte files
  {
    files: ['**/*.ts', '**/*.svelte'],
    rules: { ...typescriptEslint.configs.recommended.rules },
  },

  // Prettier config (flattened)
  ...(Array.isArray(prettierConfig) ? prettierConfig : [prettierConfig]),

  // Global settings and common rules (applied only to TS, Svelte, and JSON)
  globalSettings,

  // Language-specific configurations
  typescriptConfig,
  svelteConfig,
  jsonConfig,
];
