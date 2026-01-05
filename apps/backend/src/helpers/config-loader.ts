/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Generic JSON config loader with Zod validation
 * Provides warning-based validation with defaults for missing fields
 *
 * Uses Bun's native file APIs where possible for better performance.
 * Sync operations use node:fs which Bun optimizes internally.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { z } from "zod";

import { logger } from "./logger.ts";

export type ConfigLoadResult<T> = {
	/** The validated and defaulted config data */
	data: T;
	/** Whether the file was successfully loaded (false if created from defaults) */
	loaded: boolean;
	/** Whether the config was modified to add defaults */
	modified: boolean;
	/** List of fields that had invalid values (stripped) */
	invalidFields: string[];
	/** List of fields that were missing (defaulted) */
	defaultedFields: string[];
};

/**
 * Load and validate a JSON config file with Zod schema
 *
 * Behavior:
 * - If file doesn't exist: returns defaults, logs warning
 * - If JSON is invalid: returns defaults, logs warning
 * - If fields fail validation: strips invalid fields, applies defaults, logs warnings
 * - If fields are missing: applies defaults from schema, logs info
 *
 * @param filePath - Path to the JSON file
 * @param schema - Zod schema for validation
 * @param defaults - Default values to apply for missing fields
 * @returns ConfigLoadResult with validated data and metadata
 */
export function loadJsonConfig<T extends z.ZodTypeAny>(
	filePath: string,
	schema: T,
	defaults: Partial<z.infer<T>> = {},
): ConfigLoadResult<z.infer<T>> {
	const result: ConfigLoadResult<z.infer<T>> = {
		data: { ...defaults } as z.infer<T>,
		loaded: false,
		modified: false,
		invalidFields: [],
		defaultedFields: [],
	};

	// Try to read the file
	let rawData: unknown;
	try {
		const fileContents = readFileSync(filePath, "utf8");
		rawData = JSON.parse(fileContents);
		result.loaded = true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			logger.warn(`Config file not found: ${filePath}, using defaults`);
		} else if (err instanceof SyntaxError) {
			logger.warn(
				`Invalid JSON in config file: ${filePath}, using defaults: ${err.message}`,
			);
		} else {
			logger.warn(
				`Failed to read config file: ${filePath}, using defaults: ${err}`,
			);
		}
		return result;
	}

	// Validate with Zod using safeParse for partial validation
	const parseResult = schema.safeParse(rawData);

	if (parseResult.success) {
		// All valid - merge with defaults for any missing optional fields
		result.data = { ...defaults, ...parseResult.data };

		// Check which defaults were applied
		if (typeof rawData === "object" && rawData !== null) {
			for (const key of Object.keys(defaults)) {
				if (!(key in rawData)) {
					result.defaultedFields.push(key);
					result.modified = true;
				}
			}
		}

		if (result.defaultedFields.length > 0) {
			logger.info(
				`Config ${filePath}: applied defaults for fields: ${result.defaultedFields.join(", ")}`,
			);
		}
	} else {
		// Validation failed - try to salvage valid fields
		logger.warn(
			`Config validation errors in ${filePath}, applying partial validation`,
		);

		// Start with defaults
		result.data = { ...defaults } as z.infer<T>;

		// Try to parse each field individually if it's an object schema
		if (typeof rawData === "object" && rawData !== null) {
			const rawObj = rawData as Record<string, unknown>;

			// Get the shape of the schema if it's an object schema
			// Zod v4 uses _zod.def.shape which is a plain object
			// biome-ignore lint/suspicious/noExplicitAny: Need to access schema internals
			const schemaDef = (schema as any)._zod?.def ?? (schema as any)._def;
			// biome-ignore lint/suspicious/noExplicitAny: Need to access schema internals
			let schemaShape: Record<string, any> | undefined;

			if (schemaDef?.shape) {
				// Zod v4 stores shape as an object directly
				schemaShape =
					typeof schemaDef.shape === "function"
						? schemaDef.shape()
						: schemaDef.shape;
			}

			if (schemaShape) {
				for (const [key, value] of Object.entries(rawObj)) {
					const fieldSchema = schemaShape[key];
					if (fieldSchema && typeof fieldSchema.safeParse === "function") {
						const fieldResult = fieldSchema.safeParse(value);
						if (fieldResult.success) {
							(result.data as Record<string, unknown>)[key] = fieldResult.data;
						} else {
							result.invalidFields.push(key);
							logger.warn(
								`Config ${filePath}: invalid value for '${key}', using default`,
							);
						}
					} else {
						// Unknown field or not a schema - keep it for forward compatibility
						(result.data as Record<string, unknown>)[key] = value;
					}
				}
			} else {
				// For record schemas or non-object schemas, just use defaults
				result.invalidFields.push("(entire config)");
			}
		}

		result.modified = true;

		// Log summary of issues
		for (const issue of parseResult.error.issues) {
			logger.debug(
				`Config validation issue: ${issue.path.join(".")}: ${issue.message}`,
			);
		}
	}

	return result;
}

/**
 * Synchronously load a JSON config with validation
 * Throws if the file is required and cannot be loaded
 *
 * @param filePath - Path to the JSON file
 * @param schema - Zod schema for validation
 * @param defaults - Default values for missing fields
 * @param required - If true, throws when file doesn't exist or is invalid
 */
export function loadJsonConfigSync<T extends z.ZodTypeAny>(
	filePath: string,
	schema: T,
	defaults: Partial<z.infer<T>> = {},
	required = false,
): z.infer<T> {
	const result = loadJsonConfig(filePath, schema, defaults);

	if (required && !result.loaded) {
		throw new Error(`Required config file not found or invalid: ${filePath}`);
	}

	return result.data;
}

/**
 * Save a config to a JSON file synchronously
 *
 * @param filePath - Path to the JSON file
 * @param data - Data to save
 * @param pretty - Whether to format with indentation (default: false for smaller files)
 */
export function saveJsonConfig<T>(
	filePath: string,
	data: T,
	pretty = false,
): void {
	const contents = pretty
		? JSON.stringify(data, null, "\t")
		: JSON.stringify(data);
	writeFileSync(filePath, contents);
}

/**
 * Save a config to a JSON file asynchronously using Bun's native API
 *
 * @param filePath - Path to the JSON file
 * @param data - Data to save
 * @param pretty - Whether to format with indentation (default: false for smaller files)
 */
export async function saveJsonConfigAsync<T>(
	filePath: string,
	data: T,
	pretty = false,
): Promise<void> {
	const contents = pretty
		? JSON.stringify(data, null, "\t")
		: JSON.stringify(data);
	await Bun.write(filePath, contents);
}

/**
 * Load a simple record-based cache file (like auth_tokens, gsm_operators, dns_cache)
 * Returns empty object if file doesn't exist or is invalid
 *
 * @param filePath - Path to the cache file
 * @param schema - Zod schema for validation
 * @param emptyDefault - Default value to return when file is missing/invalid (defaults to {})
 */
export function loadCacheFile<T extends z.ZodTypeAny>(
	filePath: string,
	schema: T,
	emptyDefault: z.infer<T> = {} as z.infer<T>,
): z.infer<T> {
	try {
		const contents = readFileSync(filePath, "utf8");
		const data = JSON.parse(contents);
		const result = schema.safeParse(data);

		if (result.success) {
			return result.data;
		}

		logger.warn(
			`Invalid cache file ${filePath}, starting with empty cache: ${result.error.message}`,
		);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.warn(`Failed to load cache file ${filePath}: ${err}`);
		}
	}

	return emptyDefault;
}

/**
 * Check if a file exists
 * Uses Bun-optimized node:fs existsSync
 */
export { existsSync as fileExists };
