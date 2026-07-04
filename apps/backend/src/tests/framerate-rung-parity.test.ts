/**
 * Framerate rung parity (Todo 1 — C6 contract gap)
 *
 * The framerate rung ladder is duplicated on purpose: `@ceraui/rpc`'s
 * `framerateSchema` (wire/validation) and the backend `config-schemas.ts`
 * `framerateSchema` (persistence, kept engine-binding-free). This test locks both
 * copies to the SAME rung set so a persisted film-rate config never validates in
 * one layer but rejects in the other.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { framerateSchema as rpcFramerateSchema } from "@ceraui/rpc/schemas";

import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../helpers/config-loader.ts";
import {
	framerateSchema as backendFramerateSchema,
	RUNTIME_CONFIG_DEFAULTS,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";

const FILM_RUNGS = [23.98, 24];
const LEGACY_RUNGS = [25, 29.97, 30, 50, 59.94, 60];

describe("framerate rung parity — @ceraui/rpc ↔ backend", () => {
	it("both schemas accept the newly-added film rungs (23.98 + 24)", () => {
		for (const rung of FILM_RUNGS) {
			expect(rpcFramerateSchema.safeParse(rung).success).toBe(true);
			expect(backendFramerateSchema.safeParse(rung).success).toBe(true);
		}
	});

	it("both schemas still accept every legacy rung", () => {
		for (const rung of LEGACY_RUNGS) {
			expect(rpcFramerateSchema.safeParse(rung).success).toBe(true);
			expect(backendFramerateSchema.safeParse(rung).success).toBe(true);
		}
	});

	it("both schemas reject an off-ladder framerate (26)", () => {
		expect(rpcFramerateSchema.safeParse(26).success).toBe(false);
		expect(backendFramerateSchema.safeParse(26).success).toBe(false);
	});

	it("the two ladders are identical (no drift)", () => {
		const all = [...FILM_RUNGS, ...LEGACY_RUNGS, 26, 23, 48];
		for (const value of all) {
			expect(rpcFramerateSchema.safeParse(value).success).toBe(
				backendFramerateSchema.safeParse(value).success,
			);
		}
	});
});

describe("runtimeConfig round-trip — persisted 24fps parses clean", () => {
	let tempDir: string;
	let configPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "framerate-parity-"));
		configPath = path.join(tempDir, "config.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes framerate:24 atomically and reads it back through the runtime schema", async () => {
		writeFileAtomicSync(
			configPath,
			JSON.stringify({ max_br: 5000, framerate: 24, resolution: "1080p" }),
		);

		const result = await loadJsonConfig(
			configPath,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(result.data.framerate).toBe(24);
		expect(result.invalidFields).not.toContain("framerate");
		expect(fs.readdirSync(tempDir)).toEqual(["config.json"]);
	});

	it("round-trips the 23.98 NTSC-film rung too", async () => {
		writeFileAtomicSync(configPath, JSON.stringify({ framerate: 23.98 }));

		const result = await loadJsonConfig(
			configPath,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(result.data.framerate).toBe(23.98);
		expect(result.invalidFields).not.toContain("framerate");
	});
});
