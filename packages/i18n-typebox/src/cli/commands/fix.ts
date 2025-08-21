/**
 * Fix command - Automatically fix common locale issues
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateLocaleFiles } from '../../validation.js';
import { detectProjectConfig, validateConfig } from '../utils/config.js';

export async function fixCommand(args: string[] = []): Promise<void> {
	console.log('🔧 Auto-fixing locale file issues...\n');

	const options = {
		dryRun: args.includes('--dry-run') || args.includes('-d'),
	};

	if (options.dryRun) {
		console.log('🧪 DRY RUN MODE - No files will be modified\n');
	}

	try {
		// Detect project configuration
		const config = detectProjectConfig();
		validateConfig(config);
		console.log('');

		// Auto-detect existing locales
		const existingLocales = getExistingLocales(config.localeDirectory);
		console.log(`📋 Found locale files: ${existingLocales.join(', ')}\n`);

		// Run validation to identify issues
		const validation = validateLocaleFiles(
			config.localeDirectory,
			config.schemaOutputPath,
			existingLocales,
		);

		let filesFixed = 0;
		let missingKeysAdded = 0;

		// Check for duplicate keys but only warn (manual fix required)
		if (Object.keys(validation.duplicateKeys).length > 0) {
			console.log('🔄 Duplicate Keys Found (Manual Fix Required):');
			for (const [locale, duplicateKeys] of Object.entries(validation.duplicateKeys)) {
				console.log(`   ❌ ${locale}.json: ${duplicateKeys.length} duplicates`);
			}
			console.log('   ⚠️  Duplicate keys require manual review to choose correct translations.\n');
		}

		// Add missing keys safely
		if (Object.keys(validation.missingKeys).length > 0) {
			console.log('⚠️  Adding missing keys with translation placeholders...\n');

			// Get the English locale as reference
			const englishData = getLocaleData(config.localeDirectory, 'en');

			for (const [locale, missingKeys] of Object.entries(validation.missingKeys)) {
				if (locale === 'en') continue; // Skip English as it's the reference

				console.log(`   📝 Adding ${missingKeys.length} missing keys to ${locale}.json...`);

				const added = addMissingKeys(
					config.localeDirectory,
					locale,
					missingKeys,
					englishData,
					options.dryRun,
				);

				if (added > 0) {
					filesFixed++;
					missingKeysAdded += added;
					console.log(`   ✅ Added ${added} missing keys with [NEEDS TRANSLATION] placeholders`);
				}
			}
		}

		// Summary
		console.log('\n📊 Fix Summary:');
		console.log(`   📁 Files processed: ${filesFixed}`);
		console.log(`   ➕ Missing keys added: ${missingKeysAdded}`);

		console.log(
			'\n🌍 For translation quality review, ask the AI assistant to analyze locale files.',
		);

		if (Object.keys(validation.duplicateKeys).length > 0) {
			console.log(
				'🔄 For duplicate key removal, manual review is recommended to preserve correct translations.',
			);
		}

		if (options.dryRun) {
			console.log('\n🧪 DRY RUN completed - no files were modified');
			console.log('💡 Run without --dry-run to apply fixes');
		} else if (filesFixed > 0) {
			console.log('\n🎉 Missing keys added successfully! Run validation again to verify.\n');
		} else {
			console.log('\n✨ No missing keys found - all locales are synchronized!\n');
		}
	} catch (error) {
		console.error('❌ Fix failed:', error);
		process.exit(1);
	}
}

/**
 * Add missing keys to a locale file
 */
function addMissingKeys(
	localeDirectory: string,
	locale: string,
	missingKeys: string[],
	englishData: any,
	dryRun: boolean,
): number {
	try {
		const filePath = join(localeDirectory, `${locale}.json`);
		const localeData = JSON.parse(readFileSync(filePath, 'utf-8'));

		let keysAdded = 0;

		for (const key of missingKeys) {
			const englishValue = getValueByPath(englishData, key);
			if (englishValue) {
				// Add the key with a placeholder indicating it needs translation
				const placeholder = `[NEEDS TRANSLATION] ${englishValue}`;
				setValueByPath(localeData, key, placeholder);
				keysAdded++;
			}
		}

		if (keysAdded > 0 && !dryRun) {
			writeFileSync(filePath, JSON.stringify(localeData, null, 2), 'utf-8');
		}

		return keysAdded;
	} catch (error) {
		console.warn(`Warning: Could not add missing keys to ${locale}:`, error);
		return 0;
	}
}

/**
 * Get locale data from file
 */
function getLocaleData(localeDirectory: string, locale: string): any {
	try {
		const filePath = join(localeDirectory, `${locale}.json`);
		return JSON.parse(readFileSync(filePath, 'utf-8'));
	} catch (error) {
		console.warn(`Warning: Could not load ${locale} locale data:`, error);
		return {};
	}
}

/**
 * Get value from object using dot notation path
 */
function getValueByPath(obj: any, path: string): any {
	return path.split('.').reduce((current, key) => current?.[key], obj);
}

/**
 * Set value in object using dot notation path
 */
function setValueByPath(obj: any, path: string, value: any): void {
	const keys = path.split('.');
	const lastKey = keys.pop()!;

	let current = obj;
	for (const key of keys) {
		if (!(key in current) || typeof current[key] !== 'object') {
			current[key] = {};
		}
		current = current[key];
	}

	current[lastKey] = value;
}

/**
 * Get existing locale files instead of using hardcoded list
 */
function getExistingLocales(localeDirectory: string): string[] {
	const { readdirSync } = require('node:fs');
	const { extname } = require('node:path');

	try {
		return readdirSync(localeDirectory)
			.filter((file: string) => extname(file) === '.json' && file !== 'locale.schema.json')
			.map((file: string) => file.replace('.json', ''));
	} catch (error) {
		console.warn('Warning: Could not read locale directory:', error);
		return [];
	}
}
