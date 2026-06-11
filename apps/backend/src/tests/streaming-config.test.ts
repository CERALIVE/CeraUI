import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadJsonConfig } from "../helpers/config-loader.ts";
import {
	RUNTIME_CONFIG_DEFAULTS,
	type RuntimeConfig,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures");

function withTempConfig(contents: string): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streaming-config-"));
	const file = path.join(dir, "config.json");
	fs.writeFileSync(file, contents);
	return { dir, file };
}

describe("unified runtime config schema", () => {
	it("round-trips a full config including the INI-generating fields", () => {
		const full: RuntimeConfig = {
			relay_server: "ceralive:0",
			relay_account: "ceralive:acct",
			relay_protocol: "srtla",
			srt_latency: 2500,
			max_br: 9000,
			delay: 100,
			balancer: "aimd",
			bitrate_overlay: true,
			asrc: "HDMI",
			acodec: "opus",
			pipeline: "h264_hdmi_1080p",
			resolution: "1080p",
			framerate: 30,
			autostart: true,
			addons: {},
		};

		const parsed = runtimeConfigSchema.parse(full);
		const reparsed = runtimeConfigSchema.parse(
			JSON.parse(JSON.stringify(parsed)),
		);

		expect(reparsed).toEqual(parsed);
		expect(reparsed.balancer).toBe("aimd");
		expect(reparsed.max_br).toBe(9000);
		expect(reparsed.srt_latency).toBe(2500);
	});

	it("treats balancer as an additive field defaulted on load", () => {
		expect(RUNTIME_CONFIG_DEFAULTS.balancer).toBe("adaptive");
	});
});

describe("legacy config.json migration", () => {
	const legacyRaw = fs.readFileSync(
		path.join(FIXTURES, "legacy-config.json"),
		"utf8",
	);

	let dir: string;
	let file: string;

	beforeEach(() => {
		({ dir, file } = withTempConfig(legacyRaw));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("loads a legacy config without error and applies additive defaults", async () => {
		const result = await loadJsonConfig(
			file,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(result.loaded).toBe(true);
		expect(result.invalidFields).toEqual([]);
		// Additive fields the legacy shape never had:
		expect(result.data.balancer).toBe("adaptive");
		expect(result.data.addons).toEqual({});
		expect(result.defaultedFields).toContain("balancer");
		expect(result.defaultedFields).toContain("addons");
		// Existing fields survive untouched:
		expect(result.data.max_br).toBe(6000);
		expect(result.data.pipeline).toBe("h264_hdmi_1080p");
		expect(result.data.relay_server).toBe("ceralive:0");
	});

	it("write-back in the unified shape is a one-shot, idempotent migration", async () => {
		const first = await loadJsonConfig(
			file,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		// Persist the migrated, unified shape (same serialization saveConfig uses).
		fs.writeFileSync(file, JSON.stringify(first.data));

		const second = await loadJsonConfig(
			file,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(second.data).toEqual(first.data);
		// Nothing left to default once the migrated shape has been written back.
		expect(second.defaultedFields).toEqual([]);
	});
});

describe("corrupt config.json handling", () => {
	let dir: string;
	let file: string;

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("falls back to defaults when the file is not valid JSON, without throwing", async () => {
		({ dir, file } = withTempConfig("{ this is : not json ,,, "));

		const result = await loadJsonConfig(
			file,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(result.loaded).toBe(false);
		expect(result.data).toEqual(RUNTIME_CONFIG_DEFAULTS);
	});

	it("strips invalid field values while preserving the valid ones", async () => {
		({ dir, file } = withTempConfig(
			JSON.stringify({
				max_br: "not-a-number",
				balancer: "bogus-algorithm",
				srt_latency: 1234,
				pipeline: "h264_hdmi_1080p",
			}),
		));

		const result = await loadJsonConfig(
			file,
			runtimeConfigSchema,
			RUNTIME_CONFIG_DEFAULTS,
		);

		expect(result.invalidFields).toContain("max_br");
		expect(result.invalidFields).toContain("balancer");
		// Valid fields survive:
		expect(result.data.srt_latency).toBe(1234);
		expect(result.data.pipeline).toBe("h264_hdmi_1080p");
		// Garbage values are replaced by defaults, never persisted:
		expect(result.data.max_br).toBe(RUNTIME_CONFIG_DEFAULTS.max_br);
		expect(result.data.balancer).toBe(RUNTIME_CONFIG_DEFAULTS.balancer);
	});
});
