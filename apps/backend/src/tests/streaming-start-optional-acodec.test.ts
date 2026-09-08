import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
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
			id: "hdmi",
			supports_audio: true,
			supports_resolution_override: true,
			supports_framerate_override: true,
			default_resolution: "1080p",
			default_framerate: 30,
		},
	],
};

const savedMockMode = process.env.MOCK_MODE;
const savedConfigPath = getConfigFilePath();
let previousConfig: ReturnType<typeof getConfig>;
let configRoot: string | undefined;

beforeAll(async () => {
	configRoot = await mkdtemp(join(tmpdir(), "ceraui-optional-acodec-"));
	setConfigFilePath(join(configRoot, "config.json"));
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
	setMockHardware("rk3588");
	await initPipelines({
		fetchEngineCapabilities: async () => ({
			caps: CAPS,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
});

beforeEach(() => {
	previousConfig = structuredClone(getConfig());
	Object.assign(getConfig(), {
		delay: 0,
		pipeline: "hdmi",
		max_br: 5000,
		srt_latency: 2000,
		bitrate_overlay: false,
		asrc: "Auto",
		acodec: undefined,
		srtla_addr: "127.0.0.1",
		srtla_port: 5000,
		srt_streamid: "persisted-stream",
	});
});

afterEach(() => {
	Object.assign(getConfig(), previousConfig);
});

afterAll(async () => {
	try {
		stopMockService();
		setMockHardware("rk3588");
		await initPipelines();
	} finally {
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		setConfigFilePath(savedConfigPath);
		if (configRoot !== undefined)
			await rm(configRoot, { recursive: true, force: true });
	}
});

test("empty start input leaves an omitted optional audio codec to the engine default", async () => {
	const result = await updateConfig({});

	expect(result.pipeline.source).toBe("hdmi");
	expect(getConfig().acodec).toBeUndefined();
});
