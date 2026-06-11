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
 * Uses Bun's native file APIs (Bun.file().text() / Bun.write()) for all I/O.
 * Loaders are async; module-level callers await them (top-level await), which
 * preserves the original boot-time load order without introducing races.
 */

import fs from "node:fs";
import path from "node:path";

import type { z } from "zod";

import { logger } from "./logger.ts";

/**
 * Type guard for Zod v4 schema shape: { _zod: { def: unknown } }
 * Zod v4 stores the schema definition under _zod.def
 */
function isZodV4Schema(schema: unknown): schema is { _zod: { def: unknown } } {
	return (
		typeof schema === "object" &&
		schema !== null &&
		"_zod" in schema &&
		typeof (schema as Record<string, unknown>)._zod === "object" &&
		(schema as Record<string, unknown>)._zod !== null &&
		"def" in ((schema as Record<string, unknown>)._zod as Record<string, unknown>)
	);
}

/**
 * Type guard for legacy Zod schema shape: { _def: unknown }
 * Zod v3 and some v4 compat paths store the schema definition under _def
 */
function isZodLegacySchema(schema: unknown): schema is { _def: unknown } {
	return (
		typeof schema === "object" &&
		schema !== null &&
		"_def" in schema &&
		typeof (schema as Record<string, unknown>)._def === "object"
	);
}

/**
 * Type-safe accessor for Zod schema definition
 * Handles both Zod v4 (_zod.def) and legacy (_def) paths
 * Returns undefined if neither path exists (preserves ?? semantics)
 */
function getSchemaDefinition(
	schema: unknown,
): Record<string, unknown> | undefined {
	if (isZodV4Schema(schema)) {
		return (schema._zod.def as Record<string, unknown>) ?? undefined;
	}
	if (isZodLegacySchema(schema)) {
		return (schema._def as Record<string, unknown>) ?? undefined;
	}
	return undefined;
}

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
export async function loadJsonConfig<T extends z.ZodTypeAny>(
	filePath: string,
	schema: T,
	defaults: Partial<z.infer<T>> = {},
): Promise<ConfigLoadResult<z.infer<T>>> {
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
		const fileContents = await Bun.file(filePath).text();
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
			const schemaDef = getSchemaDefinition(schema);
			let schemaShape: Record<string, unknown> | undefined;

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
 * Load a JSON config with validation, rejecting when a required file is missing
 *
 * Returns only the validated data (without the load metadata). Despite the
 * historical "Sync" suffix this is async (Bun file I/O); the throw semantics
 * for required files are preserved as a rejected promise.
 *
 * @param filePath - Path to the JSON file
 * @param schema - Zod schema for validation
 * @param defaults - Default values for missing fields
 * @param required - If true, rejects when file doesn't exist or is invalid
 */
export async function loadJsonConfigSync<T extends z.ZodTypeAny>(
	filePath: string,
	schema: T,
	defaults: Partial<z.infer<T>> = {},
	required = false,
): Promise<z.infer<T>> {
	const result = await loadJsonConfig(filePath, schema, defaults);

	if (required && !result.loaded) {
		throw new Error(`Required config file not found or invalid: ${filePath}`);
	}

	return result.data;
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
 * Atomically write a string to disk: write to a sibling temp file, fsync it to
 * durable storage, then rename over the target. The rename is atomic on POSIX,
 * so a crash mid-write leaves the original file intact — readers never observe a
 * truncated config.json (E3 guardrail). Synchronous because config save callers
 * (setBitrate/setAutostart) depend on the write completing before they return.
 */
export function writeFileAtomicSync(filePath: string, contents: string): void {
	const dir = path.dirname(filePath);
	const tmpPath = path.join(
		dir,
		`.${path.basename(filePath)}.${process.pid}.tmp`,
	);

	const fd = fs.openSync(tmpPath, "w");
	try {
		fs.writeFileSync(fd, contents);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}

	try {
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// Temp already gone; nothing to clean up.
		}
		throw err;
	}
}

/**
 * Load a simple record-based cache file (like auth_tokens, gsm_operators, dns_cache)
 * Returns empty object if file doesn't exist or is invalid
 *
 * @param filePath - Path to the cache file
 * @param schema - Zod schema for validation
 * @param emptyDefault - Default value to return when file is missing/invalid (defaults to {})
 */
export async function loadCacheFile<T extends z.ZodTypeAny>(
	filePath: string,
	schema: T,
	emptyDefault: z.infer<T> = {} as z.infer<T>,
): Promise<z.infer<T>> {
	try {
		const contents = await Bun.file(filePath).text();
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
 * Check if a file exists, using Bun's native file API
 *
 * @param filePath - Path to check
 * @returns Promise resolving to true if the file exists
 */
export const fileExists = (filePath: string): Promise<boolean> =>
	Bun.file(filePath).exists();
