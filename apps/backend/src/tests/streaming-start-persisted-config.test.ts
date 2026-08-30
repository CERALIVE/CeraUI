import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";

import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { RelaysCache } from "../helpers/config-schemas.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	getRelays,
	setRelaysCacheMock,
} from "../modules/remote/remote-relays.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import { mergePersistedStartConfig } from "../modules/streaming/start-config-merge.ts";
import { updateConfig } from "../modules/streaming/streaming.ts";

const CAPS: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		{
			id: "test",
			supports_audio: false,
			supports_resolution_override: true,
			supports_framerate_override: true,
			default_resolution: "1080p",
			default_framerate: 30,
		},
	],
};

const RELAYS = {
	servers: {
		managed: {
			type: "srtla",
			name: "Managed relay",
			addr: "127.0.0.3",
			port: 7000,
		},
	},
	accounts: {
		account: { name: "Managed account", ingest_key: "managed-stream" },
	},
};

const provide = () => ({
	fetchEngineCapabilities: async () => ({
		caps: CAPS,
		schemaVersion: SCHEMA_VERSION,
	}),
	fetchEngineDevices: async () => ({ devices: [] }),
});

const savedMockMode = process.env.MOCK_MODE;
let previousConfig: ReturnType<typeof getConfig>;
let previousRelays: RelaysCache | undefined;
let configFile = "";

function setValidManualConfig(): void {
	Object.assign(getConfig(), {
		delay: 137,
		pipeline: "test",
		max_br: 4321,
		srt_latency: 2456,
		bitrate_overlay: true,
		relay_protocol: "srtla",
		relay_server: undefined,
		relay_account: undefined,
		srtla_addr: "127.0.0.1",
		srtla_port: 5000,
		srt_streamid: "persisted-stream",
	});
}

beforeAll(async () => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
	setMockHardware("rk3588");
	await initPipelines(provide());
});

beforeEach(async () => {
	previousConfig = structuredClone(getConfig());
	previousRelays = structuredClone(getRelays());
	configFile = await Bun.file("config.json").text();
	setRelaysCacheMock(structuredClone(RELAYS));
	setValidManualConfig();
});

afterEach(async () => {
	Object.assign(getConfig(), previousConfig);
	setRelaysCacheMock(previousRelays);
	await Bun.write("config.json", configFile);
});

afterAll(async () => {
	stopMockService();
	setMockHardware("rk3588");
	await initPipelines();
	if (savedMockMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMockMode;
});

test("empty start input hydrates every required field without mutating its caller", async () => {
	const params = {};
	const result = await updateConfig(params);

	expect(result).toMatchObject({
		srtlaAddr: "127.0.0.1",
		srtlaPort: 5000,
		streamid: "persisted-stream",
	});
	expect(result.pipeline.source).toBe("test");
	expect(params).toEqual({});
	expect(getConfig()).toMatchObject({
		delay: 137,
		pipeline: "test",
		max_br: 4321,
		srt_latency: 2456,
		bitrate_overlay: true,
	});
});

test("only defined request fields override persisted values", () => {
	const effective = mergePersistedStartConfig(getConfig(), {
		delay: 222,
		pipeline: undefined,
	});

	expect(effective.delay).toBe(222);
	expect(effective.pipeline).toBe("test");
});

test("manual endpoint input clears a persisted managed relay and account", async () => {
	Object.assign(getConfig(), {
		relay_server: "managed",
		relay_account: "account",
		srtla_addr: undefined,
		srtla_port: undefined,
		srt_streamid: undefined,
	});
	const requested = {
		srtla_addr: "127.0.0.2",
		srtla_port: 6000,
		srt_streamid: "manual-stream",
	};

	const result = await updateConfig(requested);

	expect(result).toMatchObject({
		srtlaAddr: "127.0.0.2",
		srtlaPort: 6000,
		streamid: "manual-stream",
	});
	expect(getConfig()).toMatchObject({
		srtla_addr: "127.0.0.2",
		srtla_port: 6000,
		srt_streamid: "manual-stream",
	});
	expect(getConfig().relay_server).toBeUndefined();
	expect(getConfig().relay_account).toBeUndefined();
	expect(requested).toEqual({
		srtla_addr: "127.0.0.2",
		srtla_port: 6000,
		srt_streamid: "manual-stream",
	});
});

test("managed relay input clears persisted manual endpoint fields", async () => {
	const result = await updateConfig({
		relay_server: "managed",
		relay_account: "account",
	});

	expect(result).toMatchObject({
		srtlaAddr: "127.0.0.3",
		srtlaPort: 7000,
		streamid: "managed-stream",
	});
	expect(getConfig()).toMatchObject({
		relay_server: "managed",
		relay_account: "account",
	});
	expect(getConfig().srtla_addr).toBeUndefined();
	expect(getConfig().srtla_port).toBeUndefined();
	expect(getConfig().srt_streamid).toBeUndefined();
});

test("unrelated partial input preserves the saved managed destination", async () => {
	Object.assign(getConfig(), {
		relay_server: "managed",
		relay_account: "account",
		srtla_addr: undefined,
		srtla_port: undefined,
		srt_streamid: undefined,
	});

	const result = await updateConfig({ max_br: 5678 });

	expect(result).toMatchObject({
		srtlaAddr: "127.0.0.3",
		srtlaPort: 7000,
		streamid: "managed-stream",
	});
	expect(getConfig()).toMatchObject({
		max_br: 5678,
		relay_server: "managed",
		relay_account: "account",
	});
});

test("explicit stream id overrides a persisted managed account", async () => {
	Object.assign(getConfig(), {
		relay_server: "managed",
		relay_account: "account",
		srtla_addr: undefined,
		srtla_port: undefined,
		srt_streamid: undefined,
	});

	const result = await updateConfig({ srt_streamid: "override-stream" });

	expect(result.streamid).toBe("override-stream");
	expect(getConfig().relay_account).toBeUndefined();
	expect(getConfig().srt_streamid).toBe("override-stream");
});

test("schema projection excludes credential and unknown fields", () => {
	const effective = mergePersistedStartConfig(
		{
			...getConfig(),
			password_hash: "persisted-secret",
			remote_key: "persisted-token",
		},
		{ max_br: 5555, password_hash: "request-secret" },
	);

	expect(effective.max_br).toBe(5555);
	expect(effective).not.toHaveProperty("password_hash");
	expect(effective).not.toHaveProperty("remote_key");
});

test("an invalid effective persisted config still fails validation", async () => {
	getConfig().delay = undefined;
	let failure: unknown;

	try {
		await updateConfig({});
	} catch (error: unknown) {
		failure = error;
	}

	expect(failure).toBeInstanceOf(Error);
	if (!(failure instanceof Error))
		throw new Error("expected updateConfig to fail");
	expect(failure.message).toContain("Invalid audio delay");
});
