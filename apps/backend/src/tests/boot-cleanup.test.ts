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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { cleanupOrphanedTempFiles } from "../helpers/boot-cleanup.ts";

describe("boot-cleanup", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = `${import.meta.dir}/fixtures/boot-cleanup-${Date.now()}`;
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("removes orphaned temp files matching the atomic-write pattern", () => {
		// Plant a temp file matching the exact pattern: .<basename>.<pid>.tmp
		const tempFile = path.join(tempDir, ".config.json.12345.tmp");
		fs.writeFileSync(tempFile, "orphaned content");

		expect(fs.existsSync(tempFile)).toBe(true);

		cleanupOrphanedTempFiles(tempDir);

		expect(fs.existsSync(tempFile)).toBe(false);
	});

	it("removes multiple orphaned temp files", () => {
		const tempFile1 = path.join(tempDir, ".config.json.111.tmp");
		const tempFile2 = path.join(tempDir, ".setup.json.222.tmp");
		const tempFile3 = path.join(tempDir, ".auth_tokens.json.333.tmp");

		fs.writeFileSync(tempFile1, "orphaned");
		fs.writeFileSync(tempFile2, "orphaned");
		fs.writeFileSync(tempFile3, "orphaned");

		cleanupOrphanedTempFiles(tempDir);

		expect(fs.existsSync(tempFile1)).toBe(false);
		expect(fs.existsSync(tempFile2)).toBe(false);
		expect(fs.existsSync(tempFile3)).toBe(false);
	});

	it("preserves real config files", () => {
		const configFile = path.join(tempDir, "config.json");
		const setupFile = path.join(tempDir, "setup.json");
		const tempFile = path.join(tempDir, ".config.json.12345.tmp");

		fs.writeFileSync(configFile, '{"test": true}');
		fs.writeFileSync(setupFile, '{"test": true}');
		fs.writeFileSync(tempFile, "orphaned");

		cleanupOrphanedTempFiles(tempDir);

		expect(fs.existsSync(configFile)).toBe(true);
		expect(fs.existsSync(setupFile)).toBe(true);
		expect(fs.existsSync(tempFile)).toBe(false);
	});

	it("ignores files that don't match the temp pattern", () => {
		const notATempFile = path.join(tempDir, "config.json.tmp");
		const anotherNotTemp = path.join(tempDir, ".config.json");
		const yetAnother = path.join(tempDir, ".config.json.notapid.tmp");

		fs.writeFileSync(notATempFile, "not a temp file");
		fs.writeFileSync(anotherNotTemp, "not a temp file");
		fs.writeFileSync(yetAnother, "not a temp file");

		cleanupOrphanedTempFiles(tempDir);

		expect(fs.existsSync(notATempFile)).toBe(true);
		expect(fs.existsSync(anotherNotTemp)).toBe(true);
		expect(fs.existsSync(yetAnother)).toBe(true);
	});

	it("is idempotent: running twice is a no-op", () => {
		const tempFile = path.join(tempDir, ".config.json.12345.tmp");
		fs.writeFileSync(tempFile, "orphaned");

		cleanupOrphanedTempFiles(tempDir);
		expect(fs.existsSync(tempFile)).toBe(false);

		// Second run should not throw
		cleanupOrphanedTempFiles(tempDir);
		expect(fs.existsSync(tempFile)).toBe(false);
	});

	it("handles permission errors gracefully (fail-soft)", () => {
		const tempFile = path.join(tempDir, ".config.json.12345.tmp");
		fs.writeFileSync(tempFile, "orphaned");

		// Make the file read-only to simulate a permission error on unlink
		fs.chmodSync(tempFile, 0o444);
		fs.chmodSync(tempDir, 0o555);

		// Should not throw, just log a warning
		expect(() => {
			cleanupOrphanedTempFiles(tempDir);
		}).not.toThrow();

		// Restore permissions for cleanup
		fs.chmodSync(tempDir, 0o755);
		fs.chmodSync(tempFile, 0o644);
	});

	it("handles missing directory gracefully (fail-soft)", () => {
		const nonexistentDir = path.join(tempDir, "nonexistent");

		// Should not throw
		expect(() => {
			cleanupOrphanedTempFiles(nonexistentDir);
		}).not.toThrow();
	});

	it("matches the exact atomic-write temp-file pattern", () => {
		// This test explicitly validates the pattern against writeFileAtomicSync's
		// naming convention: .<basename>.<pid>.tmp
		// See config-loader.ts:278-283 for the source pattern.

		const validPatterns = [
			".config.json.1.tmp",
			".config.json.12345.tmp",
			".setup.json.999.tmp",
			".auth_tokens.json.0.tmp",
		];

		const invalidPatterns = [
			"config.json.12345.tmp", // missing leading dot
			".config.json.tmp", // missing pid
			".config.json.abc.tmp", // pid is not numeric
			"..config.json.123.tmp", // double leading dot
			".config.json.123", // missing .tmp suffix
		];

		// Create and verify valid patterns are removed
		for (const pattern of validPatterns) {
			const file = path.join(tempDir, pattern);
			fs.writeFileSync(file, "test");
		}

		cleanupOrphanedTempFiles(tempDir);

		for (const pattern of validPatterns) {
			const file = path.join(tempDir, pattern);
			expect(fs.existsSync(file)).toBe(
				false,
				`Valid pattern ${pattern} should have been removed`,
			);
		}

		// Create and verify invalid patterns are NOT removed
		for (const pattern of invalidPatterns) {
			const file = path.join(tempDir, pattern);
			fs.writeFileSync(file, "test");
		}

		cleanupOrphanedTempFiles(tempDir);

		for (const pattern of invalidPatterns) {
			const file = path.join(tempDir, pattern);
			expect(fs.existsSync(file)).toBe(
				true,
				`Invalid pattern ${pattern} should NOT have been removed`,
			);
		}
	});
});
