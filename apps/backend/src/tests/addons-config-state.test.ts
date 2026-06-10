import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AddonState } from "@ceraui/rpc/schemas";

import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../helpers/config-loader.ts";
import {
	RUNTIME_CONFIG_DEFAULTS,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";

const sampleState: AddonState = {
	enabled: true,
	phase: "active",
	versionMaterialized: "1.2.3",
	userConfig: { theme: "dark" },
	autoDisabled: false,
};

describe("config.json add-on state", () => {
	let tempDir: string;
	let configPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "addons-config-"));
		configPath = path.join(tempDir, "config.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("defaults addons to {} when the key is absent", async () => {
		fs.writeFileSync(configPath, JSON.stringify({ max_br: 6000 }));

		const result = await loadJsonConfig(
			configPath,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(result.data.addons).toEqual({});
		expect(result.defaultedFields).toContain("addons");
	});

	it("round-trips an add-on state through an atomic write", async () => {
		const persisted = { max_br: 5000, addons: { hdmi: sampleState } };
		writeFileAtomicSync(configPath, JSON.stringify(persisted));

		const result = await loadJsonConfig(
			configPath,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(result.data.addons).toEqual({ hdmi: sampleState });
		// No temp artifact may survive a successful write.
		expect(fs.readdirSync(tempDir)).toEqual(["config.json"]);
	});

	it("leaves the original config intact when a write is interrupted before rename", () => {
		const original = { max_br: 5000, addons: { hdmi: sampleState } };
		writeFileAtomicSync(configPath, JSON.stringify(original));

		// Simulate a crash mid-write: the new bytes land in the sibling temp file
		// and fsync, but the process dies before the atomic rename runs.
		const tmpPath = path.join(tempDir, `.config.json.${process.pid}.tmp`);
		const fd = fs.openSync(tmpPath, "w");
		fs.writeFileSync(fd, '{"max_br":9999,"addons":{"hdmi":{"enab');
		fs.fsyncSync(fd);
		fs.closeSync(fd);

		// The target was never the write destination, so it still parses cleanly.
		const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
		expect(onDisk).toEqual(original);
		expect(runtimeConfigSchema.safeParse(onDisk).success).toBe(true);
	});
});
