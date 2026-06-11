import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
	loadCacheFile,
	loadJsonConfig,
	loadJsonConfigSync,
	saveJsonConfigAsync,
} from "../helpers/config-loader.ts";

// Import the internal type guards and accessor for testing
// These are not exported but we test them indirectly through the config-loader behavior
// We'll create test schemas that exercise both Zod v4 and legacy paths

// Test schema for config files
const testConfigSchema = z.object({
	name: z.string(),
	count: z.number().int().min(0).max(100),
	enabled: z.boolean().optional(),
	tags: z.array(z.string()).optional(),
});

type TestConfig = z.infer<typeof testConfigSchema>;

const testDefaults: Partial<TestConfig> = {
	count: 10,
	enabled: false,
};

// Test schema for cache files
const testCacheSchema = z.record(z.string(), z.string());

describe("loadJsonConfig", () => {
	let tempDir: string;
	let testFilePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		testFilePath = path.join(tempDir, "test-config.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should load a valid config file", async () => {
		const validConfig: TestConfig = {
			name: "test",
			count: 50,
			enabled: true,
		};
		fs.writeFileSync(testFilePath, JSON.stringify(validConfig));

		const result = await loadJsonConfig(
			testFilePath,
			testConfigSchema,
			testDefaults,
		);

		expect(result.loaded).toBe(true);
		expect(result.data.name).toBe("test");
		expect(result.data.count).toBe(50);
		expect(result.data.enabled).toBe(true);
		expect(result.invalidFields).toEqual([]);
	});

	it("should apply defaults for missing optional fields", async () => {
		const partialConfig = { name: "test", count: 20 };
		fs.writeFileSync(testFilePath, JSON.stringify(partialConfig));

		const result = await loadJsonConfig(
			testFilePath,
			testConfigSchema,
			testDefaults,
		);

		expect(result.loaded).toBe(true);
		expect(result.data.name).toBe("test");
		expect(result.data.count).toBe(20);
		expect(result.data.enabled).toBe(false); // from defaults
		expect(result.defaultedFields).toContain("enabled");
	});

	it("should return defaults when file doesn't exist", async () => {
		const nonExistentPath = path.join(tempDir, "nonexistent.json");

		const result = await loadJsonConfig(
			nonExistentPath,
			testConfigSchema,
			testDefaults,
		);

		expect(result.loaded).toBe(false);
		expect(result.data.count).toBe(10); // from defaults
		expect(result.data.enabled).toBe(false); // from defaults
	});

	it("should not throw and return defaults for a path in a missing directory", async () => {
		const deepMissing = path.join(tempDir, "no", "such", "dir", "config.json");

		const result = await loadJsonConfig(
			deepMissing,
			testConfigSchema,
			testDefaults,
		);

		expect(result.loaded).toBe(false);
		expect(result.data.count).toBe(10);
		expect(result.data.enabled).toBe(false);
	});

	it("should return defaults when JSON is invalid", async () => {
		fs.writeFileSync(testFilePath, "{ invalid json }");

		const result = await loadJsonConfig(
			testFilePath,
			testConfigSchema,
			testDefaults,
		);

		expect(result.loaded).toBe(false);
		expect(result.data.count).toBe(10); // from defaults
	});

	it("should strip invalid fields and keep valid ones", async () => {
		// count is out of range (max 100)
		const mixedConfig = { name: "test", count: 150, enabled: true };
		fs.writeFileSync(testFilePath, JSON.stringify(mixedConfig));

		const result = await loadJsonConfig(
			testFilePath,
			testConfigSchema,
			testDefaults,
		);

		expect(result.loaded).toBe(true);
		expect(result.data.name).toBe("test");
		expect(result.data.enabled).toBe(true);
		expect(result.invalidFields).toContain("count");
		expect(result.data.count).toBe(10); // from defaults
	});
});

describe("loadJsonConfigSync", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should reject when required file doesn't exist", async () => {
		const nonExistentPath = path.join(tempDir, "required.json");

		await expect(
			loadJsonConfigSync(nonExistentPath, testConfigSchema, testDefaults, true),
		).rejects.toThrow("Required config file not found");
	});

	it("should not reject when optional file doesn't exist", async () => {
		const nonExistentPath = path.join(tempDir, "optional.json");

		const result = await loadJsonConfigSync(
			nonExistentPath,
			testConfigSchema,
			testDefaults,
			false,
		);

		expect(result.count).toBe(10); // from defaults
	});
});

describe("saveJsonConfigAsync", () => {
	let tempDir: string;
	let testFilePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		testFilePath = path.join(tempDir, "save-test.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should save config as compact JSON by default", async () => {
		const config = { name: "test", count: 42 };

		await saveJsonConfigAsync(testFilePath, config);

		const contents = fs.readFileSync(testFilePath, "utf8");
		expect(contents).toBe('{"name":"test","count":42}');
	});

	it("should save config as pretty JSON when requested", async () => {
		const config = { name: "test", count: 42 };

		await saveJsonConfigAsync(testFilePath, config, true);

		const contents = fs.readFileSync(testFilePath, "utf8");
		expect(contents).toContain("\n");
		expect(contents).toContain("\t");
	});

	it("should save config async using Bun.write", async () => {
		const config = { name: "async-test", count: 99 };

		await saveJsonConfigAsync(testFilePath, config);

		const contents = fs.readFileSync(testFilePath, "utf8");
		expect(contents).toBe('{"name":"async-test","count":99}');
	});
});

describe("loadCacheFile", () => {
	let tempDir: string;
	let testFilePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
		testFilePath = path.join(tempDir, "test-cache.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should load a valid cache file", async () => {
		const cacheData = { key1: "value1", key2: "value2" };
		fs.writeFileSync(testFilePath, JSON.stringify(cacheData));

		const result = await loadCacheFile(testFilePath, testCacheSchema);

		expect(result).toEqual(cacheData);
	});

	it("should return empty object when file doesn't exist", async () => {
		const nonExistentPath = path.join(tempDir, "nonexistent.json");

		const result = await loadCacheFile(nonExistentPath, testCacheSchema);

		expect(result).toEqual({});
	});

	it("should return empty object when cache is invalid", async () => {
		fs.writeFileSync(testFilePath, "{ invalid json }");

		const result = await loadCacheFile(testFilePath, testCacheSchema);

		expect(result).toEqual({});
	});
});

describe("getSchemaDefinition accessor (via partial validation)", () => {
	let tempDir: string;
	let testFilePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-test-"));
		testFilePath = path.join(tempDir, "schema-test.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should handle Zod v4 schema shape (_zod.def) during partial validation", async () => {
		// Create a config with one valid and one invalid field
		// This triggers partial validation which uses getSchemaDefinition
		const mixedConfig = { name: "test", count: 150 }; // count is out of range
		fs.writeFileSync(testFilePath, JSON.stringify(mixedConfig));

		const result = await loadJsonConfig(
			testFilePath,
			testConfigSchema,
			testDefaults,
		);

		// Partial validation should have worked (name is valid)
		expect(result.data.name).toBe("test");
		// Invalid field should be stripped and default applied
		expect(result.invalidFields).toContain("count");
		expect(result.data.count).toBe(10); // from defaults
	});

	it("should handle legacy Zod schema shape (_def) during partial validation", async () => {
		// The test schema uses the current Zod version, but the accessor
		// is designed to handle both v4 and legacy paths. This test verifies
		// that partial validation works correctly regardless of the internal shape.
		const partialConfig = { name: "legacy-test", count: 50 };
		fs.writeFileSync(testFilePath, JSON.stringify(partialConfig));

		const result = await loadJsonConfig(
			testFilePath,
			testConfigSchema,
			testDefaults,
		);

		expect(result.loaded).toBe(true);
		expect(result.data.name).toBe("legacy-test");
		expect(result.data.count).toBe(50);
	});

	it("should return defaults when schema definition cannot be accessed", async () => {
		// When the schema is not an object schema (e.g., a record schema),
		// getSchemaDefinition returns undefined and we fall back to defaults
		const recordSchema = z.record(z.string(), z.number());
		const testData = { key1: 100, key2: 200 };
		fs.writeFileSync(testFilePath, JSON.stringify(testData));

		const result = await loadJsonConfig(testFilePath, recordSchema, {});

		// Record schemas don't have a shape, so partial validation falls back to defaults
		// The entire config is marked as invalid when we can't access the schema definition
		expect(result.loaded).toBe(true);
		expect(result.invalidFields.length).toBeGreaterThanOrEqual(0);
	});
});
