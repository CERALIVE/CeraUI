/**
 * Generate command - Create JSON schema and framework adapters
 */

import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { generateSvelteStore } from '../../adapters/svelte.js';
import { generateJsonSchema } from '../../generators/json-schema.js';
import { validateLocaleFiles } from '../../validation.js';
import { detectProjectConfig, validateConfig } from '../utils/config.js';

export async function generateCommand(args: string[] = []): Promise<void> {
	console.log('🚀 Starting TypeScript-first i18n code generation...\n');

	try {
		// Detect project configuration
		const config = detectProjectConfig();
		validateConfig(config);
		console.log('');

		// Dynamic import of the schema (TypeScript support via Bun)
		let schemaModule;
		try {
			schemaModule = await import(config.schemaPath);
		} catch (error) {
			if (config.schemaPath.endsWith('.ts')) {
				// If it's a TypeScript file, provide execution method guidance
				const isBun = typeof (globalThis as any).Bun !== 'undefined';
				const runtime = isBun ? 'Bun' : 'Node.js';

				throw new Error(`❌ Cannot import TypeScript file with ${runtime}.

Available options:
  📦 pnpm run i18n:generate          # Recommended (uses Bun)
  🚀 bun i18n-typebox generate       # Direct with Bun
  📦 pnpm dlx i18n-typebox generate  # If compiled to JS
  📦 npx i18n-typebox generate       # If compiled to JS

Current schema: ${config.schemaPath}`);
			}
			throw error;
		}

		// Try different possible export names
		const schema =
			schemaModule.CeraUISchema || schemaModule.I18nSchema || schemaModule.default || schemaModule;

		if (!schema || typeof schema !== 'object') {
			throw new Error(`❌ Could not find valid schema export in ${config.schemaPath}`);
		}

		console.log('✅ Loaded schema successfully\n');

		// Generate JSON Schema
		generateJsonSchema(schema, config.schemaOutputPath);
		console.log('');

		// Generate Svelte 5 store
		ensureDirectoryExists(config.outputDirectory);
		const storePath = `${config.outputDirectory}/i18n.svelte.ts`;

		// Calculate relative path from output to schema types
		const typesImportPath = getRelativeImportPath(storePath, config.schemaPath);

		generateSvelteStore(schema, storePath, typesImportPath);
		console.log('');

		// Validate locale files - auto-detect existing locales instead of hardcoded list
		const existingLocales = getExistingLocales(config.localeDirectory);
		console.log(`📋 Found locale files: ${existingLocales.join(', ')}`);
		const validation = validateLocaleFiles(
			config.localeDirectory,
			config.schemaOutputPath,
			existingLocales,
		);
		console.log('');

		// Summary
		console.log('🎉 i18n code generation completed successfully!\n');

		if (validation.invalid.length > 0) {
			console.log('⚠️  Some locale files had validation errors. Please review and fix.');
			process.exit(1);
		}
	} catch (error) {
		console.error('❌ Generation failed:', error);
		process.exit(1);
	}
}

/**
 * Ensure directory exists
 */
function ensureDirectoryExists(dirPath: string): void {
	mkdirSync(dirname(dirPath), { recursive: true });
}

/**
 * Get existing locale files instead of using hardcoded list
 */
function getExistingLocales(localeDirectory: string): string[] {
	try {
		return readdirSync(localeDirectory)
			.filter((file) => extname(file) === '.json' && file !== 'locale.schema.json')
			.map((file) => file.replace('.json', ''));
	} catch (error) {
		console.warn('Warning: Could not read locale directory:', error);
		return [];
	}
}

/**
 * Calculate relative import path from one file to another
 */
function getRelativeImportPath(fromPath: string, toPath: string): string {
	// For now, use a default relative path
	// This could be enhanced to calculate the actual relative path
	return '../../../../../types/ceraui-i18n.js';
}
