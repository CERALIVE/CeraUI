import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
	loadCacheFile,
	loadJsonConfig,
	loadJsonConfigSync,
	saveJsonConfig,
	saveJsonConfigAsync,
} from "../helpers/config-loader.ts";

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

	it("should load a valid config file", () => {
		const validConfig: TestConfig = {
			name: "test",
			count: 50,
			enabled: true,
		};
		fs.writeFileSync(testFilePath, JSON.stringify(validConfig));

		const result = loadJsonConfig(testFilePath, testConfigSchema, testDefaults);

		expect(result.loaded).toBe(true);
		expect(result.data.name).toBe("test");
		expect(result.data.count).toBe(50);
		expect(result.data.enabled).toBe(true);
		expect(result.invalidFields).toEqual([]);
	});

	it("should apply defaults for missing optional fields", () => {
		const partialConfig = { name: "test", count: 20 };
		fs.writeFileSync(testFilePath, JSON.stringify(partialConfig));

		const result = loadJsonConfig(testFilePath, testConfigSchema, testDefaults);

		expect(result.loaded).toBe(true);
		expect(result.data.name).toBe("test");
		expect(result.data.count).toBe(20);
		expect(result.data.enabled).toBe(false); // from defaults
		expect(result.defaultedFields).toContain("enabled");
	});

	it("should return defaults when file doesn't exist", () => {
		const nonExistentPath = path.join(tempDir, "nonexistent.json");

		const result = loadJsonConfig(
			nonExistentPath,
			testConfigSchema,
			testDefaults,
		);

		expect(result.loaded).toBe(false);
		expect(result.data.count).toBe(10); // from defaults
		expect(result.data.enabled).toBe(false); // from defaults
	});

	it("should return defaults when JSON is invalid", () => {
		fs.writeFileSync(testFilePath, "{ invalid json }");

		const result = loadJsonConfig(testFilePath, testConfigSchema, testDefaults);

		expect(result.loaded).toBe(false);
		expect(result.data.count).toBe(10); // from defaults
	});

	it("should strip invalid fields and keep valid ones", () => {
		// count is out of range (max 100)
		const mixedConfig = { name: "test", count: 150, enabled: true };
		fs.writeFileSync(testFilePath, JSON.stringify(mixedConfig));

		const result = loadJsonConfig(testFilePath, testConfigSchema, testDefaults);

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

	it("should throw when required file doesn't exist", () => {
		const nonExistentPath = path.join(tempDir, "required.json");

		expect(() =>
			loadJsonConfigSync(nonExistentPath, testConfigSchema, testDefaults, true),
		).toThrow("Required config file not found");
	});

	it("should not throw when optional file doesn't exist", () => {
		const nonExistentPath = path.join(tempDir, "optional.json");

		const result = loadJsonConfigSync(
			nonExistentPath,
			testConfigSchema,
			testDefaults,
			false,
		);

		expect(result.count).toBe(10); // from defaults
	});
});

describe("saveJsonConfig", () => {
	let tempDir: string;
	let testFilePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		testFilePath = path.join(tempDir, "save-test.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should save config as compact JSON by default", () => {
		const config = { name: "test", count: 42 };

		saveJsonConfig(testFilePath, config);

		const contents = fs.readFileSync(testFilePath, "utf8");
		expect(contents).toBe('{"name":"test","count":42}');
	});

	it("should save config as pretty JSON when requested", () => {
		const config = { name: "test", count: 42 };

		saveJsonConfig(testFilePath, config, true);

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

	it("should load a valid cache file", () => {
		const cacheData = { key1: "value1", key2: "value2" };
		fs.writeFileSync(testFilePath, JSON.stringify(cacheData));

		const result = loadCacheFile(testFilePath, testCacheSchema);

		expect(result).toEqual(cacheData);
	});

	it("should return empty object when file doesn't exist", () => {
		const nonExistentPath = path.join(tempDir, "nonexistent.json");

		const result = loadCacheFile(nonExistentPath, testCacheSchema);

		expect(result).toEqual({});
	});

	it("should return empty object when cache is invalid", () => {
		fs.writeFileSync(testFilePath, "{ invalid json }");

		const result = loadCacheFile(testFilePath, testCacheSchema);

		expect(result).toEqual({});
	});
});
