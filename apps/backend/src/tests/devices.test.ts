import { describe, expect, mock, test } from "bun:test";

import {
	buildDeviceList,
	createDeviceRegistry,
	type DeviceRegistryDeps,
	deriveKind,
} from "../modules/streaming/devices.ts";

function makeDeps(
	overrides: Partial<DeviceRegistryDeps> = {},
): Partial<DeviceRegistryDeps> {
	return {
		listVideoCards: async () => ["video0", "video1", "video63"],
		readCardName: async (card) =>
			({
				video0: "RØDE HDMI to USB-C: RØDE HDMI",
				video1: "RØDE HDMI to USB-C: RØDE HDMI",
				video63: "QA-Cam",
			})[card],
		getAudioSources: () => ({
			"No audio": "No audio",
			"Pipeline default": "Pipeline default",
			"USB audio": "usbaudio",
		}),
		getEngine: () => "cerastream",
		isStreaming: () => false,
		engineSwitch: async () => undefined,
		// Force the v4l2 fallback path for these scans (engine unreachable).
		getEngineDevices: async () => null,
		getSelectedVideoInput: () => undefined,
		clearSelectedVideoInput: () => undefined,
		notify: () => undefined,
		broadcast: () => undefined,
		now: () => 0,
		logger: { debug() {}, warn() {}, error() {} },
		...overrides,
	};
}

describe("deriveKind", () => {
	test("groups by display name keywords", () => {
		expect(deriveKind("RØDE HDMI")).toBe("hdmi");
		expect(deriveKind("SRT Ingest")).toBe("network");
		expect(deriveKind("Test Pattern")).toBe("test");
		expect(deriveKind("USB Webcam")).toBe("usb");
		expect(deriveKind("QA-Cam")).toBe("usb");
		expect(deriveKind("Mystery")).toBe("other");
	});
});

describe("buildDeviceList", () => {
	test("dedups video by display name, keeps one node per source", () => {
		const list = buildDeviceList(
			[
				{ card: "video0", name: "RØDE HDMI" },
				{ card: "video1", name: "RØDE HDMI" },
				{ card: "video63", name: "QA-Cam" },
			],
			{},
		);
		const video = list.filter((d) => d.media_class === "video");
		expect(video.map((d) => d.display_name)).toEqual(["RØDE HDMI", "QA-Cam"]);
		expect(video[0]?.input_id).toBe("/dev/video0");
	});

	test("includes audio sources but skips pipeline pseudo-sources", () => {
		const list = buildDeviceList([], {
			"No audio": "No audio",
			"Pipeline default": "Pipeline default",
			"USB audio": "usbaudio",
		});
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			media_class: "audio",
			kind: "audio",
			input_id: "audio:usbaudio",
			display_name: "USB audio",
		});
	});
});

describe("device registry", () => {
	test("scan surfaces v4l2 + audio devices, deduped", async () => {
		const registry = createDeviceRegistry(makeDeps());
		const devices = await registry.scan();
		const names = devices.map((d) => d.display_name);
		expect(names).toContain("QA-Cam");
		expect(names).toContain("USB audio");
		// RØDE collapsed to one entry
		expect(names.filter((n) => n.includes("RØDE"))).toHaveLength(1);
	});

	test("rescan broadcasts only when the list changes", async () => {
		const broadcast = mock(() => undefined);
		let cards = ["video63"];
		const registry = createDeviceRegistry(
			makeDeps({
				broadcast,
				getAudioSources: () => ({}),
				listVideoCards: async () => cards,
				readCardName: async () => "QA-Cam",
			}),
		);
		await registry.rescan();
		expect(broadcast).toHaveBeenCalledTimes(1);
		await registry.rescan();
		expect(broadcast).toHaveBeenCalledTimes(1); // unchanged → no rebroadcast
		cards = [];
		await registry.rescan();
		expect(broadcast).toHaveBeenCalledTimes(2); // device removed → rebroadcast
	});

	test("switchInput returns a sub-frame gap_ms and sets the active input", async () => {
		let clock = 0;
		const registry = createDeviceRegistry(
			makeDeps({
				getAudioSources: () => ({}),
				listVideoCards: async () => ["video63"],
				readCardName: async () => "QA-Cam",
				now: () => {
					const t = clock;
					clock += 12;
					return t;
				},
			}),
		);
		const result = await registry.switchInput("/dev/video63");
		expect(result.success).toBe(true);
		expect(result.active_input).toBe("/dev/video63");
		expect(result.gap_ms).toBeGreaterThanOrEqual(0);
		expect(result.gap_ms).toBeLessThanOrEqual(67);
		expect(registry.getActiveInput()).toBe("/dev/video63");
	});

	test("switchInput to a missing device returns SOURCE_LOST", async () => {
		const registry = createDeviceRegistry(
			makeDeps({
				getAudioSources: () => ({}),
				listVideoCards: async () => [],
				readCardName: async () => undefined,
			}),
		);
		const result = await registry.switchInput("video63");
		expect(result.success).toBe(false);
		expect(result.error).toBe("SOURCE_LOST");
	});

	test("delegates to the engine only while streaming on cerastream", async () => {
		const engineSwitch = mock(async () => undefined);
		const registry = createDeviceRegistry(
			makeDeps({
				engineSwitch,
				getAudioSources: () => ({}),
				getEngine: () => "cerastream",
				isStreaming: () => true,
				listVideoCards: async () => ["video63"],
				readCardName: async () => "QA-Cam",
			}),
		);
		await registry.switchInput("/dev/video63");
		expect(engineSwitch).toHaveBeenCalledTimes(1);
	});
});
