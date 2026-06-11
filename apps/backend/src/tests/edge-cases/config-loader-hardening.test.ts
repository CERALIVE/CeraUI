import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Edge-case hardening for the device config loader (helpers/config-loader.ts).
//
// config.json is the device's persisted brain — bitrate, relay, autostart. The
// three guarantees that keep a corrupt/partial config from bricking a boot are:
//
//   1. atomic write -> read round-trips cleanly AND leaves no temp residue
//      (writeFileAtomicSync: write sibling .tmp, fsync, rename — never a
//      half-written config.json);
//   2. a REQUIRED config that is corrupt is rejected (not silently treated as
//      "use defaults" — the caller must know setup is broken);
//   3. partial validation defaults invalid KNOWN fields while preserving unknown
//      ones for forward compatibility (an older binary must not eat new keys).
//
// These extend config-loader.test.ts (which covers the happy paths + simple
// corrupt/partial cases); they deliberately exercise the atomic-writer round
// trip, the required-AND-corrupt rejection, and the forward-compat preservation,
// none of which the existing suite asserts.

import {
	loadJsonConfig,
	loadJsonConfigSync,
	writeFileAtomicSync,
} from "../../helpers/config-loader.ts";

const schema = z.object({
	name: z.string(),
	count: z.number().int().min(0).max(100),
	enabled: z.boolean().optional(),
});

const defaults = { count: 10, enabled: false } as const;

describe("config-loader: atomic write -> read round trip", () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-atomic-"));
		filePath = path.join(tempDir, "config.json");
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips data written atomically and leaves no temp file behind", async () => {
		const original = { name: "device-1", count: 42, enabled: true };
		writeFileAtomicSync(filePath, JSON.stringify(original));

		const result = await loadJsonConfig(filePath, schema, defaults);
		expect(result.loaded).toBe(true);
		expect(result.data.name).toBe("device-1");
		expect(result.data.count).toBe(42);
		expect(result.data.enabled).toBe(true);

		// The crash-safe writer must NOT leave its sibling .<name>.<pid>.tmp scratch
		// file behind — only the final config.json may remain in the directory.
		const leftovers = fs.readdirSync(tempDir);
		expect(leftovers).toEqual(["config.json"]);
		expect(leftovers.some((f) => f.includes(".tmp"))).toBe(false);
	});

	it("overwrites an existing config atomically (second write wins, no residue)", async () => {
		writeFileAtomicSync(filePath, JSON.stringify({ name: "old", count: 1 }));
		writeFileAtomicSync(filePath, JSON.stringify({ name: "new", count: 2 }));

		const result = await loadJsonConfig(filePath, schema, defaults);
		expect(result.data.name).toBe("new");
		expect(result.data.count).toBe(2);
		// Atomic replace must leave exactly the target file (no temp from either write).
		expect(fs.readdirSync(tempDir)).toEqual(["config.json"]);
	});
});

describe("config-loader: a required config that is corrupt is rejected", () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-required-"));
		filePath = path.join(tempDir, "setup.json");
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects when a required file contains invalid JSON (does not silently default)", async () => {
		// Corrupt JSON: a required config must surface the failure, not pretend the
		// file loaded. (loadJsonConfig flags it loaded:false on a SyntaxError, and
		// loadJsonConfigSync turns loaded:false + required into a rejection.)
		fs.writeFileSync(filePath, "{ this is : not, valid json ]");

		await expect(
			loadJsonConfigSync(filePath, schema, defaults, true),
		).rejects.toThrow("Required config file not found or invalid");
	});

	it("still returns defaults for the SAME corrupt file when it is optional", async () => {
		fs.writeFileSync(filePath, "{ this is : not, valid json ]");

		// Same corruption, required=false: must degrade to defaults rather than
		// throw — proving the rejection above is driven by `required`, not by a
		// generic parse-error crash.
		const data = await loadJsonConfigSync(filePath, schema, defaults, false);
		expect(data.count).toBe(10);
		expect(data.enabled).toBe(false);
	});
});

describe("config-loader: partial validation preserves forward-compat fields", () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-partial-"));
		filePath = path.join(tempDir, "config.json");
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("defaults an invalid known field but keeps an unknown future field", async () => {
		// `count` is out of range (triggers partial validation); `futureFlag` is a
		// key this binary does not know. The loader must default the bad known
		// field AND carry the unknown one through untouched — so a newer config
		// written by a future build is not silently stripped by an older device.
		const raw = { name: "device-9", count: 999, futureFlag: "keep-me" };
		fs.writeFileSync(filePath, JSON.stringify(raw));

		const result = await loadJsonConfig(filePath, schema, defaults);

		// Valid field survives, invalid known field is reset to the default...
		expect(result.data.name).toBe("device-9");
		expect(result.invalidFields).toContain("count");
		expect(result.data.count).toBe(10);
		// ...and the unknown forward-compat field is preserved verbatim.
		expect((result.data as Record<string, unknown>).futureFlag).toBe("keep-me");
	});
});
