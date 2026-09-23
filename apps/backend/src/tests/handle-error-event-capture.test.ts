import { afterEach, expect, test } from "bun:test";
import type {
	GetCapabilitiesResult,
	RuntimeErrorEvent,
} from "@ceralive/cerastream";
import { SCHEMA_VERSION } from "@ceralive/cerastream";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";

const caps: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "1920x1080",
	},
	encoder: {
		codecs: ["h264"],
		bitrate_range: { min: 500, max: 8000, unit: "kbps" },
	},
	sources: [],
};

async function advertise(features: string[]) {
	await getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: { ...caps, features },
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
}

const captureError: RuntimeErrorEvent = {
	type: "error",
	seq: 1,
	source: "engine",
	code: "capture_video_error",
	reason: "unavailable",
};

afterEach(() => clearCapabilitiesCache());

test("a capture-standby engine suppresses the conflicting generic video fault toast", async () => {
	await advertise(["capture-standby"]);
	const notified: unknown[][] = [];
	const errors: string[] = [];
	const backend = new CerastreamBackend({
		bridge: {
			notify: (...args) => {
				notified.push(args);
			},
			notificationExists: () => false,
			removeNotification: () => {},
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
	});
	backend.onError((error) => {
		errors.push(error);
	});
	backend.handleEvent(captureError);
	expect(notified).toEqual([]);
	expect(errors).toHaveLength(1);
});

test("legacy engine without the feature emits the byte-identical generic toast", async () => {
	await advertise([]);
	const notified: unknown[][] = [];
	const backend = new CerastreamBackend({
		bridge: {
			notify: (...args) => {
				notified.push(args);
			},
			notificationExists: () => false,
			removeNotification: () => {},
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
	});
	backend.handleEvent(captureError);
	expect(notified).toEqual([
		[
			"cerastream",
			"error",
			"Capture card error (video). No automatic restart is scheduled.",
			5,
			true,
			true,
		],
	]);
});
