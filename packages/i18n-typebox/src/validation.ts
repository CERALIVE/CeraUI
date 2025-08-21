/**
 * Validation Utilities for i18n Files
 *
 * Validates locale JSON files against generated schema
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Comprehensive locale validation results
 */
export interface LocaleValidationResult {
	valid: string[];
	invalid: string[];
	missing: string[];
	duplicateKeys: Record<string, string[]>;
	missingKeys: Record<string, string[]>;
	summary: {
		totalFiles: number;
		validFiles: number;
		duplicateIssues: number;
		missingKeyIssues: number;
	};
}

/**
 * Comprehensive validate locale files with detailed analysis
 */
export function validateLocaleFiles(
	localeDirectory: string,
	schemaPath: string,
	supportedLocales: string[] = [],
): LocaleValidationResult {
	console.log('🔧 Comprehensive locale validation...');

	const results: LocaleValidationResult = {
		valid: [],
		invalid: [],
		missing: [],
		duplicateKeys: {},
		missingKeys: {},
		summary: {
			totalFiles: 0,
			validFiles: 0,
			duplicateIssues: 0,
			missingKeyIssues: 0,
		},
	};

	try {
		// Read the schema for validation
		const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

		// Get all JSON files in locale directory
		const files = readdirSync(localeDirectory).filter(
			(file) => extname(file) === '.json' && file !== 'locale.schema.json',
		);

		results.summary.totalFiles = files.length;

		// Load all locale data for cross-validation
		const localeData: Record<string, any> = {};
		
		for (const file of files) {
			const filePath = join(localeDirectory, file);
			const locale = file.replace('.json', '');

			try {
				const content = JSON.parse(readFileSync(filePath, 'utf-8'));
				localeData[locale] = content;
			} catch (error) {
				results.invalid.push(file);
				console.log(`❌ ${file}: Invalid JSON - ${error}`);
				continue;
			}
		}

		// 1. Check for duplicate keys
		for (const file of files) {
			const filePath = join(localeDirectory, file);
			const locale = file.replace('.json', '');
			
			const duplicateKeys = findDuplicateKeys(filePath);
			if (duplicateKeys.length > 0) {
				results.duplicateKeys[locale] = duplicateKeys;
				results.invalid.push(file);
				results.summary.duplicateIssues++;
				console.log(`❌ ${file}: Contains duplicate keys: ${duplicateKeys.join(', ')}`);
			}
		}

		// 2. Check for missing keys across locales
		const allKeys = getAllKeysFromLocales(localeData);
		for (const [locale, data] of Object.entries(localeData)) {
			const localeKeys = getAllKeysFromObject(data);
			const missing = allKeys.filter(key => !localeKeys.includes(key));
			
			if (missing.length > 0) {
				results.missingKeys[locale] = missing;
				results.summary.missingKeyIssues++;
				if (!results.invalid.includes(`${locale}.json`)) {
					results.invalid.push(`${locale}.json`);
				}
				console.log(`⚠️  ${locale}.json: Missing ${missing.length} keys: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`);
			}
		}

		// 3. Mark valid files (no issues)
		for (const file of files) {
			const locale = file.replace('.json', '');
			const hasIssues = results.invalid.includes(file) || 
							 results.duplicateKeys[locale] || 
							 results.missingKeys[locale];
			
			if (!hasIssues) {
				results.valid.push(file);
				results.summary.validFiles++;
				console.log(`✅ ${file}: Valid`);
			}
		}

		// Check for missing locales
		for (const locale of supportedLocales) {
			const fileName = `${locale}.json`;
			if (!files.includes(fileName)) {
				results.missing.push(fileName);
				console.log(`⚠️  Locale file not found: ${fileName}`);
			}
		}

	} catch (error) {
		console.error('Failed to validate locale files:', error);
	}

	return results;
}

/**
 * Find duplicate keys in a JSON file by parsing the raw text
 */
function findDuplicateKeys(filePath: string): string[] {
	try {
		const content = readFileSync(filePath, 'utf-8');
		const keyMatches = content.match(/"([^"]+)":/g);

		if (!keyMatches) return [];

		const keys = keyMatches.map((match) => match.slice(1, -2)); // Remove quotes and colon
		const keyCount = new Map<string, number>();

		for (const key of keys) {
			keyCount.set(key, (keyCount.get(key) || 0) + 1);
		}

		return Array.from(keyCount.entries())
			.filter(([_, count]) => count > 1)
			.map(([key, _]) => key);
	} catch (error) {
		console.warn(`Warning: Could not check for duplicates in ${filePath}:`, error);
		return [];
	}
}

/**
 * Get all unique keys across all locale files
 */
function getAllKeysFromLocales(localeData: Record<string, any>): string[] {
	const allKeys = new Set<string>();
	
	for (const data of Object.values(localeData)) {
		const keys = getAllKeysFromObject(data);
		keys.forEach(key => allKeys.add(key));
	}
	
	return Array.from(allKeys).sort();
}

/**
 * Get all dot-notation keys from a nested object
 */
function getAllKeysFromObject(obj: any, prefix: string = ''): string[] {
	const keys: string[] = [];
	
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			// Recursive for nested objects
			keys.push(...getAllKeysFromObject(value, fullKey));
		} else {
			// Leaf node (string, number, etc.)
			keys.push(fullKey);
		}
	}
	
	return keys;
}



/**
 * Basic structural validation (can be enhanced with proper JSON Schema validation)
 */
function validateStructure(content: unknown, schema: any): boolean {
	// Basic validation - could be enhanced with a proper JSON Schema validator
	// For now, just check if it's an object and has expected top-level keys
	if (typeof content !== 'object' || content === null) {
		return false;
	}

	const contentObj = content as Record<string, unknown>;

	// Check if $schema property exists (optional)
	if ('$schema' in contentObj) {
		// Valid - has schema reference
	}

	// Basic structure check - ensure it's an object with string values or nested objects
	return Object.values(contentObj).every(
		(value) => typeof value === 'string' || (typeof value === 'object' && value !== null),
	);
}
