import { beforeEach, describe, expect, test } from "bun:test";
import {
	type GetCapabilitiesResult,
	type ListDevicesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	type CapabilitiesLogger,
	clearCapabilitiesCache,
	getCapabilities,
	getLastCapabilities,
} from "../modules/streaming/capabilities.ts";

const silent: CapabilitiesLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function makeCaps(
	bitrateRange: { min: number; max: number; unit: string } = {
		min: 1000,
		max: 12000,
		unit: "kbps",
	},
): GetCapabilitiesResult {
	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "3840x2160",
		},
		encoder: { codecs: ["H264", "H265"], bitrate_range: bitrateRange },
		sources: [
			{
				id: "hdmi",
				supports_audio: true,
				supports_resolution_override: true,
				supports_framerate_override: true,
				default_resolution: "1920x1080",
				default_framerate: 60,
			},
		],
	};
}

// The real Tier-2 wire shape (notepad todo 7): FRAMESIZES × FRAMEINTERVALS
// cross-product, one CaptureCap per {media_type × W×H × string-fraction framerate}.
const CAPS_FULL_DEVICES: ListDevicesResult = {
	devices: [
		{
			input_id: "hdmi",
			device_path: "/dev/video0",
			display_name: "HDMI Capture",
			media_class: "video",
			kind: "hdmi",
			caps: [
				{
					width: 1920,
					height: 1080,
					framerate: "30/1",
					media_type: "video/x-raw",
				},
				{
					width: 1920,
					height: 1080,
					framerate: "60/1",
					media_type: "video/x-raw",
				},
				{
					width: 3840,
					height: 2160,
					framerate: "30/1",
					media_type: "video/x-raw",
				},
			],
		},
		{
			input_id: "usb",
			device_path: "/dev/video1",
			display_name: "USB Capture",
			media_class: "video",
			kind: "uvc_h264",
			caps: [
				{
					width: 1280,
					height: 720,
					framerate: "30/1",
					media_type: "video/x-h264",
				},
				{
					width: 1280,
					height: 720,
					framerate: "60/1",
					media_type: "video/x-h264",
				},
				{
					width: 1920,
					height: 1080,
					framerate: "30/1",
					media_type: "video/x-h264",
				},
			],
		},
	],
};

const noDevices = async (): Promise<ListDevicesResult> => ({ devices: [] });

beforeEach(() => {
	clearCapabilitiesCache();
});

describe("getCapabilities — device_modes fold", () => {
	test("folds list-devices caps into grouped device_modes keyed by input_id", async () => {
		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: makeCaps(),
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => structuredClone(CAPS_FULL_DEVICES),
			logger: silent,
		});

		const modes = result.device_modes;
		expect(modes).toBeDefined();
		expect(Object.keys(modes ?? {})).toEqual(["hdmi", "usb"]);
		// duplicate resolutions collapse into one {width,height,framerates[]} entry.
		expect(modes?.hdmi).toEqual({
			kind: "hdmi",
			modes: [
				{
					width: 1920,
					height: 1080,
					framerates: [30, 60],
					media_type: "video/x-raw",
				},
				{
					width: 3840,
					height: 2160,
					framerates: [30],
					media_type: "video/x-raw",
				},
			],
		});
		expect(modes?.usb).toEqual({
			kind: "uvc_h264",
			modes: [
				{
					width: 1280,
					height: 720,
					framerates: [30, 60],
					media_type: "video/x-h264",
				},
				{
					width: 1920,
					height: 1080,
					framerates: [30],
					media_type: "video/x-h264",
				},
			],
		});
	});

	test("omits device_modes when the engine returns no/empty caps", async () => {
		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: makeCaps(),
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({
				devices: [
					{
						input_id: "hdmi",
						device_path: "/dev/video0",
						display_name: "HDMI Capture",
						media_class: "video",
						kind: "hdmi",
						caps: [],
					},
				],
			}),
			logger: silent,
		});

		expect(result.device_modes).toBeUndefined();
		expect(result.engineUnavailable).toBe(false);
	});

	test("drops framerates that snap to no legal rung (fail-closed)", async () => {
		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: makeCaps(),
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({
				devices: [
					{
						input_id: "usb",
						device_path: "/dev/video1",
						display_name: "USB Capture",
						media_class: "video",
						kind: "uvc_h264",
						caps: [
							{ width: 1920, height: 1080, framerate: "30/1" },
							{ width: 1920, height: 1080, framerate: "24000/1001" },
						],
					},
				],
			}),
			logger: silent,
		});

		expect(result.device_modes?.usb?.modes).toEqual([
			{ width: 1920, height: 1080, framerates: [30] },
		]);
	});
});

describe("getCapabilities — list-devices tolerance", () => {
	test("a throwing list-devices still emits the capabilities snapshot without device_modes", async () => {
		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: makeCaps(),
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => {
				throw new Error("list-devices unavailable");
			},
			logger: silent,
		});

		expect(result.device_modes).toBeUndefined();
		expect(result.engineUnavailable).toBe(false);
		expect(result.sources).toEqual(makeCaps().sources);
	});
});

describe("getCapabilities — bitrate unit normalization", () => {
	test("converts a bps bitrate range to kbps before broadcast", async () => {
		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: makeCaps({ min: 500_000, max: 20_000_000, unit: "bps" }),
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: noDevices,
			logger: silent,
		});

		expect(result.encoder.bitrate_range).toEqual({
			min: 500,
			max: 20000,
			unit: "kbps",
		});
	});

	test("passes a kbps bitrate range through unchanged", async () => {
		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: makeCaps({ min: 1000, max: 12000, unit: "kbps" }),
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: noDevices,
			logger: silent,
		});

		expect(result.encoder.bitrate_range).toEqual({
			min: 1000,
			max: 12000,
			unit: "kbps",
		});
	});
});

describe("getCapabilities — network_embedded_audio threading (Task 13)", () => {
	test("carries an advertised network_embedded_audio onto the live snapshot", async () => {
		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: makeCaps(),
				schemaVersion: SCHEMA_VERSION,
				network_embedded_audio: true,
			}),
			fetchEngineDevices: noDevices,
			logger: silent,
		});

		expect(result.network_embedded_audio).toBe(true);
		expect(getLastCapabilities()?.network_embedded_audio).toBe(true);
	});

	test("omits the field when the engine does not advertise it (legacy engine)", async () => {
		const result = await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: makeCaps(),
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: noDevices,
			logger: silent,
		});

		expect(result.network_embedded_audio).toBeUndefined();
	});

	test("a cached fallback retains the last-known network_embedded_audio", async () => {
		await getCapabilities({
			fetchEngineCapabilities: async () => ({
				caps: makeCaps(),
				schemaVersion: SCHEMA_VERSION,
				network_embedded_audio: true,
			}),
			fetchEngineDevices: noDevices,
			logger: silent,
		});

		const cached = await getCapabilities({
			fetchEngineCapabilities: async () => {
				throw new Error("engine unavailable");
			},
			fetchEngineDevices: noDevices,
			logger: silent,
		});

		expect(cached.engineUnavailable).toBe(true);
		expect(cached.network_embedded_audio).toBe(true);
	});
});
