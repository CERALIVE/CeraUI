import { afterAll, beforeAll, expect, test } from "bun:test";

import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
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
			id: "test",
			supports_audio: false,
			supports_resolution_override: true,
			supports_framerate_override: true,
			default_resolution: "1080p",
			default_framerate: 30,
		},
	],
};

const provide = () => ({
	fetchEngineCapabilities: async () => ({
		caps: CAPS,
		schemaVersion: SCHEMA_VERSION,
	}),
	fetchEngineDevices: async () => ({ devices: [] }),
});

const savedMockMode = process.env.MOCK_MODE;

beforeAll(async () => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
	setMockHardware("rk3588");
	await initPipelines(provide());
});

afterAll(async () => {
	stopMockService();
	setMockHardware("rk3588");
	await initPipelines();
	if (savedMockMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMockMode;
});

test("empty start input hydrates every required field from persisted config", async () => {
	const config = getConfig();
	const previous = {
		delay: config.delay,
		pipeline: config.pipeline,
		max_br: config.max_br,
		srt_latency: config.srt_latency,
		bitrate_overlay: config.bitrate_overlay,
		srtla_addr: config.srtla_addr,
		srtla_port: config.srtla_port,
		srt_streamid: config.srt_streamid,
		relay_server: config.relay_server,
		relay_account: config.relay_account,
		relay_protocol: config.relay_protocol,
	};
	const configFile = await Bun.file("config.json").text();

	try {
		config.delay = 137;
		config.pipeline = "test";
		config.max_br = 4321;
		config.srt_latency = 2456;
		config.bitrate_overlay = true;
		config.srtla_addr = "127.0.0.1";
		config.srtla_port = 5000;
		config.srt_streamid = "persisted-stream";
		config.relay_server = undefined;
		config.relay_account = undefined;
		config.relay_protocol = "srtla";

		const params = {};
		const result = await updateConfig(params);

		expect(result.pipeline.source).toBe("test");
		expect(params).toEqual(
			expect.objectContaining({
				delay: 137,
				pipeline: "test",
				max_br: 4321,
				srt_latency: 2456,
				bitrate_overlay: true,
				srtla_addr: "127.0.0.1",
				srtla_port: 5000,
				srt_streamid: "persisted-stream",
			}),
		);
	} finally {
		Object.assign(config, previous);
		await Bun.write("config.json", configFile);
	}
});
