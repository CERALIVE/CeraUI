/**
 * Validate command - Validate locale files against JSON schema
 */

import { readdirSync } from 'node:fs';
import { extname } from 'node:path';
import { validateLocaleFiles } from '../../validation.js';
import { detectProjectConfig, validateConfig } from '../utils/config.js';

export async function validateCommand(args: string[] = []): Promise<void> {
	console.log('🔧 Validating i18n locale files...\n');

	try {
		// Detect project configuration
		const config = detectProjectConfig();
		validateConfig(config);
		console.log('');

		// Auto-detect existing locales instead of hardcoded list
		const existingLocales = getExistingLocales(config.localeDirectory);
		console.log(`📋 Found locale files: ${existingLocales.join(', ')}\n`);

		// Validate locale files
		const validation = validateLocaleFiles(
			config.localeDirectory,
			config.schemaOutputPath,
			existingLocales,
		);

		console.log('\n📊 Comprehensive Validation Summary:');
		console.log(`   📁 Total files: ${validation.summary.totalFiles}`);
		console.log(`   ✅ Valid files: ${validation.summary.validFiles}`);
		console.log(`   🔄 Duplicate key issues: ${validation.summary.duplicateIssues}`);
		console.log(`   ⚠️  Missing key issues: ${validation.summary.missingKeyIssues}`);

		if (validation.invalid.length > 0) {
			console.log('\n❌ Files with issues:');
			validation.invalid.forEach((file) => console.log(`   • ${file}`));
		}

		if (validation.missing.length > 0) {
			console.log('\n⚠️  Missing locale files:');
			validation.missing.forEach((file) => console.log(`   • ${file}`));
		}

		// Detailed breakdown
		if (Object.keys(validation.duplicateKeys).length > 0) {
			console.log('\n🔄 Duplicate Key Details:');
			for (const [locale, keys] of Object.entries(validation.duplicateKeys)) {
				console.log(`   ${locale}: ${keys.length} duplicates`);
			}
		}

		if (Object.keys(validation.missingKeys).length > 0) {
			console.log('\n⚠️  Missing Key Details:');
			for (const [locale, keys] of Object.entries(validation.missingKeys)) {
				console.log(`   ${locale}: ${keys.length} missing keys`);
			}
		}

		const hasAnyIssues =
			validation.invalid.length > 0 ||
			validation.missing.length > 0 ||
			validation.summary.duplicateIssues > 0 ||
			validation.summary.missingKeyIssues > 0;

		if (!hasAnyIssues) {
			console.log('\n🎉 All locale files are valid and complete!\n');
		} else {
			console.log(
				'\n💡 Use `pnpm run i18n:fix` to add missing keys (duplicates require manual review).\n',
			);
			process.exit(1);
		}
	} catch (error) {
		console.error('❌ Validation failed:', error);
		process.exit(1);
	}
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
