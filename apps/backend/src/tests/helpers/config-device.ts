/**
 * A device for the frontend's harness: the real procedures, config and
 * broadcast in a process of their own (mocked engine, two microphones, a camera
 * and an RTMP ingest). One JSON request per line on stdin; each answer is one
 * `DEVICE ` line with the exact frames a signed-in socket was sent and the
 * call's result.
 */
import { createInterface } from "node:readline";
import { SCHEMA_VERSION } from "@ceralive/cerastream";
import { call } from "@orpc/server";

import { initMockService } from "../../mocks/mock-service.ts";
import { setMockNetworkIngestActive } from "../../mocks/providers/network-ingest.ts";
import { getConfig, setConfigFilePath } from "../../modules/config.ts";
import { refreshNetworkIngestInfo } from "../../modules/network/network-ingest.ts";
import { setMockAudioDevicesProvider } from "../../modules/streaming/audio.ts";
import {
	initPipelines,
	setMockHardware,
} from "../../modules/streaming/pipelines.ts";
import { applyObservedEngineDevices } from "../../modules/streaming/sources.ts";
import { broadcastConfig } from "../../rpc/config-broadcast.ts";
import { createContext } from "../../rpc/context.ts";
import { addClient } from "../../rpc/events.ts";
import { setAudioMixProcedure } from "../../rpc/procedures/audio-mix.procedure.ts";
import {
	getConfigProcedure,
	setConfigProcedure,
} from "../../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket } from "../../rpc/types.ts";
import { osmo } from "./dual-mode-camera.ts";

process.env.MOCK_MODE = "true";
setConfigFilePath(`${process.cwd()}/config.json`);
initMockService("caps-full");
setMockHardware("rk3588");
const source = (id: string) => ({
	id,
	supports_audio: true,
	supports_resolution_override: true,
	supports_framerate_override: true,
	default_resolution: "1080p",
	default_framerate: 30,
});
await initPipelines({
	fetchEngineCapabilities: async () => ({
		caps: {
			platform: {
				supports_h265: true,
				hardware_accelerated: true,
				max_resolution: "2160p",
			},
			encoder: {
				codecs: ["h264", "h265"],
				bitrate_range: { min: 500, max: 50000, unit: "kbps" },
			},
			sources: [source("hdmi"), source("libuvch264"), source("rtmp")],
			network_embedded_audio: true,
			audio_mix: {
				max_inputs: 4,
				max_tracks: 4,
				gain_db_min: -60,
				gain_db_max: 12,
				delay_ms_max: 2000,
			},
		},
		schemaVersion: SCHEMA_VERSION,
	}),
	fetchEngineDevices: async () => ({ devices: [] }),
});
setMockNetworkIngestActive("rtmp", true);
await refreshNetworkIngestInfo();
setMockAudioDevicesProvider(() => ({
	"usb-a": "hw:CARD=a",
	"usb-b": "hw:CARD=b",
}));
applyObservedEngineDevices([osmo("osmo")]);

let sent: string[] = [];
const tab = {
	data: { isAuthenticated: true, lastActive: 0 },
	send: (message: string) => {
		sent.push(message);
	},
} as unknown as AppWebSocket;
addClient(tab);
const context = createContext(tab);

const methods: Record<string, (input: never) => unknown> = {
	/** A device whose config is `input`, which its tabs are told of. */
	become: (input: object) => {
		for (const key of Object.keys(getConfig()))
			Reflect.deleteProperty(getConfig(), key);
		Object.assign(getConfig(), input);
		broadcastConfig(getConfig());
	},
	getConfig: () => call(getConfigProcedure, undefined, { context }),
	setAudioMix: (input) => call(setAudioMixProcedure, input, { context }),
	setConfig: (input) => call(setConfigProcedure, input, { context }),
};

for await (const line of createInterface({ input: process.stdin })) {
	const { method, input } = JSON.parse(line) as {
		method: string;
		input: never;
	};
	sent = [];
	const result = await methods[method]?.(input);
	const frames = sent.filter((message) =>
		["config", "config_clear"].includes(
			Object.keys(JSON.parse(message) as object)[0] ?? "",
		),
	);
	process.stdout.write(`DEVICE ${JSON.stringify({ frames, result })}\n`);
}
process.exit(0);
