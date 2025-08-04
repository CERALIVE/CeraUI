import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixupPluginRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import tsEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintImport from 'eslint-plugin-import';
import jsonc from 'eslint-plugin-jsonc';
import promise from 'eslint-plugin-promise';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import jsoncParser from 'jsonc-eslint-parser';
import svelteParser from 'svelte-eslint-parser';

// ----------------------------------------------------------------------------
// SETUP
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

const svelteModule = await import('eslint-plugin-svelte');
const svelte = fixupPluginRules(svelteModule.default || svelteModule);

// ----------------------------------------------------------------------------
// PLUGINS
// ----------------------------------------------------------------------------

const plugins = {
  import: fixupPluginRules(eslintImport),
  '@typescript-eslint': fixupPluginRules(tsEslint),
  'unused-imports': fixupPluginRules(unusedImports),
  '@jsonc': fixupPluginRules(jsonc),
  'simple-import-sort': fixupPluginRules(simpleImportSort),
  unicorn: fixupPluginRules(unicorn),
  promise: fixupPluginRules(promise),
  svelte,
};

// ----------------------------------------------------------------------------
// SHARED RULESET
// ----------------------------------------------------------------------------

const baseRules = {
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

  // Import organization
  'import/first': 'error',
  'import/newline-after-import': 'error',
  'simple-import-sort/imports': 'error',
  'simple-import-sort/exports': 'error',

  // Promise hygiene
  'promise/param-names': 'error',
  'promise/no-return-wrap': 'error',
  'promise/no-new-statics': 'error',
  'promise/no-return-in-finally': 'warn',

  // Unicorn improvements
  'unicorn/better-regex': 'error',
  'unicorn/error-message': 'error',
  'unicorn/prefer-includes': 'error',
  'unicorn/prefer-string-slice': 'error',
};

// ----------------------------------------------------------------------------
// LANGUAGE OPTIONS
// ----------------------------------------------------------------------------

const sharedLanguageOptions = {
  globals: {
    ...globals.browser,
    ...globals.node,
    ...globals.jest,
    NodeJS: 'readonly',
    __APP_VERSION__: 'readonly',
  },
  ecmaVersion: 2022,
  sourceType: 'module',
};

// ----------------------------------------------------------------------------
// CONFIG SECTIONS
// ----------------------------------------------------------------------------

const globalSettings = {
  files: ['**/*.ts', '**/*.svelte', '**/*.json'],
  plugins,
  languageOptions: sharedLanguageOptions,
  settings: {
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
    'import/resolver': {
      typescript: { alwaysTryTypes: true },
    },
    'import/cache': true,
    'import/ignore': ['node_modules', '\\.(css|md|svg|json)$'],
  },
  rules: baseRules,
};

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

const svelteConfig = {
  files: ['**/*.svelte'],
  languageOptions: {
    parser: svelteParser,
    parserOptions: {
      parser: tsParser,
      extraFileExtensions: ['.svelte'],
      jsx: true,
    },
  },
  rules: {
    ...svelte.configs.recommended.rules,
    'svelte/valid-compile': 'warn',
    'no-undef': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',

    // Svelte 5 specific adjustments
    'svelte/no-reactive-reassign': 'off',
    'svelte/valid-each-key': 'warn',
    'svelte/no-at-html-tags': 'warn',
    'svelte/no-dom-manipulating': 'warn',
  },
};

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

const prettierConfig = compat.extends('plugin:prettier/recommended');

// ----------------------------------------------------------------------------
// EXPORT
// ----------------------------------------------------------------------------

export default [
  {
    ignores: [
      '**/dist',
      '**/dev-dist',
      '**/node_modules',
      '**/public',
      '**/*.d.ts',
      '**/build',
      '**/coverage',
      '**/.svelte-kit',
    ],
  },

  // JS base config
  js.configs.recommended,

  // TS & Svelte base rules (recommended)
  {
    files: ['**/*.ts', '**/*.svelte'],
    rules: { ...tsEslint.configs.recommended.rules },
  },

  ...(Array.isArray(prettierConfig) ? prettierConfig : [prettierConfig]),

  globalSettings,
  typescriptConfig,
  svelteConfig,
  jsonConfig,
];
