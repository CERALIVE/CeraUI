import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixupPluginRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import tsEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';

// ----------------------------------------------------------------------------
// SETUP
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
	baseDirectory: __dirname,
});

const svelteModule = await import('eslint-plugin-svelte');
const svelte = fixupPluginRules(svelteModule.default || svelteModule);

// ----------------------------------------------------------------------------
// PLUGINS (Svelte-focused)
// ----------------------------------------------------------------------------

const plugins = {
	svelte,
	'simple-import-sort': fixupPluginRules(simpleImportSort),
	'unused-imports': fixupPluginRules(unusedImports),
	'@typescript-eslint': fixupPluginRules(tsEslint),
};

// ----------------------------------------------------------------------------
// LANGUAGE OPTIONS
// ----------------------------------------------------------------------------

const sharedLanguageOptions = {
	globals: {
		...globals.browser,
		...globals.node,
		NodeJS: 'readonly',
		__APP_VERSION__: 'readonly',
		// Svelte 5 runes (complete set)
		$state: 'readonly',
		$derived: 'readonly',
		$effect: 'readonly',
		$props: 'readonly',
		$bindable: 'readonly',
		$inspect: 'readonly',
		$host: 'readonly',
	},
	ecmaVersion: 2024,
	sourceType: 'module',
};

// ----------------------------------------------------------------------------
// SVELTE CONFIGURATION
// ----------------------------------------------------------------------------

const svelteConfig = {
	files: ['**/*.svelte'],
	plugins,
	languageOptions: {
		...sharedLanguageOptions,
		parser: svelteParser,
		parserOptions: {
			parser: tsParser,
			extraFileExtensions: ['.svelte'],
			jsx: true,
			svelteFeatures: {
				experimentalGenerics: true, // Svelte 5 feature
			},
		},
	},
	rules: {
		// ──────────────────────────────────────────────────────────────────────
		// Svelte Core Rules (from recommended config)
		// ──────────────────────────────────────────────────────────────────────
		...svelte.configs.recommended.rules,

		// ──────────────────────────────────────────────────────────────────────
		// Svelte 5 Runes Mode Adjustments
		// ──────────────────────────────────────────────────────────────────────
		'svelte/valid-compile': 'warn',
		'svelte/no-reactive-reassign': 'off', // Not applicable in runes mode
		'svelte/valid-each-key': 'warn',
		'svelte/no-at-html-tags': 'warn',
		'svelte/no-dom-manipulating': 'warn',

		// ──────────────────────────────────────────────────────────────────────
		// Svelte Best Practices
		// ──────────────────────────────────────────────────────────────────────
		'svelte/button-has-type': 'off', // Disabled - can be overly strict for component buttons
		'svelte/no-target-blank': 'error',
		'svelte/no-useless-mustaches': 'error',
		'svelte/prefer-class-directive': 'error',
		'svelte/prefer-style-directive': 'error',
		'svelte/require-each-key': 'off', // Disabled - not always necessary for static lists
		'svelte/shorthand-attribute': 'error',
		'svelte/shorthand-directive': 'error',
		'svelte/sort-attributes': 'warn',

		// ──────────────────────────────────────────────────────────────────────
		// Svelte Formatting
		// ──────────────────────────────────────────────────────────────────────
		'svelte/html-quotes': ['error', { prefer: 'double' }],
		'svelte/mustache-spacing': 'error',
		'svelte/no-spaces-around-equal-signs-in-attribute': 'error',

		// ──────────────────────────────────────────────────────────────────────
		// JavaScript/TypeScript Code Style (consistent with Biome)
		// ──────────────────────────────────────────────────────────────────────

		// Variables & Constants (enhanced for Svelte)
		'no-unused-vars': 'off', // Disabled in favor of unused-imports plugin
		'unused-imports/no-unused-imports': 'error',
		'unused-imports/no-unused-vars': 'off', // Disabled - too aggressive with TypeScript type definitions
		'@typescript-eslint/no-unused-vars': [
			'warn',
			{
				vars: 'all',
				varsIgnorePattern: '^_|^\\$\\$(Props|Events|Slots)$',
				args: 'after-used',
				argsIgnorePattern: '^_',
				caughtErrors: 'all',
				caughtErrorsIgnorePattern: '^_',
				ignoreRestSiblings: true,
			},
		],
		'no-var': 'error',
		'prefer-const': 'off', // Disabled for Svelte - conflicts with $props() destructuring and reactivity
		'prefer-template': 'warn',

		// Code Quality
		'no-debugger': 'error',
		'no-console': 'warn',
		'no-unreachable': 'error',
		'no-duplicate-imports': 'off', // Disabled in favor of unused-imports plugin which handles this better
		'no-useless-catch': 'error',

		// Import Organization (consistent with Biome)
		'simple-import-sort/imports': 'error',
		'simple-import-sort/exports': 'error',

		// Modern JavaScript
		'prefer-arrow-callback': 'warn',
		'prefer-destructuring': 'warn',
		'object-shorthand': 'warn',

		// Disable conflicts with Svelte/TypeScript
		'no-undef': 'off', // TypeScript handles this
	},
};

const prettierConfig = compat.extends('plugin:prettier/recommended');

// ----------------------------------------------------------------------------
// ENHANCED EXPORT (Svelte-only)
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
			'**/playwright-report',
			'**/.vite',
			// Ignore JS/TS files - handled by Biome at root level
			'**/*.js',
			'**/*.mjs',
			'**/*.ts',
			'**/*.jsx',
			'**/*.tsx',
		],
	},

	// Prettier integration (restricted to Svelte files only)
	...(Array.isArray(prettierConfig) ? prettierConfig : [prettierConfig]).map(config => ({
		...config,
		files: ['**/*.svelte'], // Restrict Prettier to Svelte files only
	})),

	// Svelte-only configuration
	svelteConfig,
];
