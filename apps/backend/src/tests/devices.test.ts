import { describe, expect, mock, test } from "bun:test";

import {
	buildDeviceList,
	createDeviceRegistry,
	type DeviceRegistryDeps,
	deriveKind,
	fromEngineDevice,
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
		getRememberedDeviceKind: () => undefined,
		notify: () => undefined,
		broadcast: () => undefined,
		onDevicesChanged: () => undefined,
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

describe("fromEngineDevice — signal verdict", () => {
	// The live Rock 5B+ pair: cerastream OMITS `caps` for the severed-link
	// HDMI-RX node and carries a full list for the UVC device beside it.
	const HDMI_RX = {
		input_id: "/dev/video0",
		device_path: "/dev/video0",
		display_name: "rk_hdmirx",
		media_class: "video" as const,
		kind: "hdmi",
		stable_id: "port:fdee0000.hdmirx-controller",
	};

	test("reports `absent` when the engine listed the device but projected no caps", () => {
		expect(fromEngineDevice(HDMI_RX).signal).toBe("absent");
	});

	test("reports `absent` for an explicitly empty caps array too", () => {
		expect(fromEngineDevice({ ...HDMI_RX, caps: [] }).signal).toBe("absent");
	});

	test("reports `present` for a device that enumerated at least one cap", () => {
		const signal = fromEngineDevice({
			...HDMI_RX,
			caps: [{ width: 1920, height: 1080, framerate: "60/1" }],
		}).signal;
		expect(signal).toBe("present");
	});

	test("leaves the verdict UNSET on the v4l2 fallback scan, so an engine outage never fakes a no-signal state", () => {
		const list = buildDeviceList([{ card: "video0", name: "QA-Cam" }], {});
		expect(list[0]?.signal).toBeUndefined();
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

	test("fires onDevicesChanged on a hotplug set change, not on the boot seed, an unchanged rescan, or an input switch", async () => {
		const onDevicesChanged = mock(() => undefined);
		let cards = ["video63"];
		const registry = createDeviceRegistry(
			makeDeps({
				onDevicesChanged,
				getAudioSources: () => ({}),
				listVideoCards: async () => cards,
				readCardName: async (card) =>
					card === "video64" ? "Second-Cam" : "QA-Cam",
			}),
		);
		await registry.rescan(); // boot seed — NOT a hotplug
		expect(onDevicesChanged).toHaveBeenCalledTimes(0);
		await registry.rescan(); // unchanged
		expect(onDevicesChanged).toHaveBeenCalledTimes(0);
		cards = ["video63", "video64"];
		await registry.rescan(); // device added → hotplug
		expect(onDevicesChanged).toHaveBeenCalledTimes(1);
		// A live input switch does not change the SET, so it must not re-probe.
		await registry.switchInput("/dev/video63");
		expect(onDevicesChanged).toHaveBeenCalledTimes(1);
		cards = ["video63"];
		await registry.rescan(); // device removed → hotplug
		expect(onDevicesChanged).toHaveBeenCalledTimes(2);
	});

	test("hands onDevicesChanged the list this scan observed, so a removal never depends on a second engine round-trip", async () => {
		const observed: string[][] = [];
		let cards = ["video63", "video64"];
		const registry = createDeviceRegistry(
			makeDeps({
				onDevicesChanged: (devices) =>
					observed.push(devices.map((d) => d.input_id)),
				getAudioSources: () => ({}),
				listVideoCards: async () => cards,
				readCardName: async (card) =>
					card === "video64" ? "Second-Cam" : "QA-Cam",
			}),
		);
		await registry.rescan(); // boot seed
		cards = ["video63"];
		await registry.rescan(); // video64 unplugged

		expect(observed).toEqual([["/dev/video63"]]);
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

	test("reports the applied video source to the lifecycle indicator on every scan", async () => {
		const reportActiveVideoSource = mock(() => undefined);
		const registry = createDeviceRegistry(
			makeDeps({
				reportActiveVideoSource,
				getAudioSources: () => ({}),
				isStreaming: () => true,
				getSelectedVideoInput: () => "/dev/video63",
				listVideoCards: async () => ["video0"],
				readCardName: async () => "RØDE HDMI",
			}),
		);
		await registry.rescan();
		expect(reportActiveVideoSource).toHaveBeenCalledWith({
			isStreaming: true,
			activeSourceId: "/dev/video63",
			presentSourceIds: ["/dev/video0"],
		});
	});
});

describe("reconcileSelectedInput — the libuvc release gap is not a disconnect", () => {
	const OSMO = {
		input_id: "/dev/video1",
		device_path: "/dev/video1",
		display_name: "DJIPocket3: OsmoPocket3",
		kind: "uvc_h264",
		media_class: "video",
	} as const;

	// The engine answers `null` (unreachable) and then a list, reproducing the
	// unreachable→reachable edge every stream start/stop crosses when the
	// session's control socket closes.
	function engineSequence(lists: (readonly unknown[] | null)[]) {
		let i = 0;
		return async () => {
			const next = lists[Math.min(i, lists.length - 1)];
			i += 1;
			return next as never;
		};
	}

	test("a uvc_h264 selection absent for ONE observation is NOT cleared", async () => {
		const clearSelectedVideoInput = mock(() => undefined);
		const notify = mock(() => undefined);
		const registry = createDeviceRegistry(
			makeDeps({
				getEngineDevices: engineSequence([null, []]),
				getSelectedVideoInput: () => "/dev/video1",
				getRememberedDeviceKind: () => "uvc_h264",
				clearSelectedVideoInput,
				notify,
			}),
		);

		await registry.rescan(); // engine unreachable
		await registry.rescan(); // reachable, camera still in its release gap

		expect(clearSelectedVideoInput).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	test("a uvc_h264 selection that comes BACK clears the pending absence", async () => {
		const clearSelectedVideoInput = mock(() => undefined);
		const registry = createDeviceRegistry(
			makeDeps({
				getEngineDevices: engineSequence([null, [], null, [OSMO], null, []]),
				getSelectedVideoInput: () => "/dev/video1",
				getRememberedDeviceKind: () => "uvc_h264",
				clearSelectedVideoInput,
			}),
		);

		for (let i = 0; i < 6; i += 1) await registry.rescan();

		expect(clearSelectedVideoInput).not.toHaveBeenCalled();
	});

	test("a uvc_h264 selection absent across TWO consecutive edges is cleared", async () => {
		const clearSelectedVideoInput = mock(() => undefined);
		const notify = mock(() => undefined);
		const registry = createDeviceRegistry(
			makeDeps({
				getEngineDevices: engineSequence([null, [], null, []]),
				getSelectedVideoInput: () => "/dev/video1",
				getRememberedDeviceKind: () => "uvc_h264",
				clearSelectedVideoInput,
				notify,
			}),
		);

		for (let i = 0; i < 4; i += 1) await registry.rescan();

		expect(clearSelectedVideoInput).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	test("a v4l2-driven kind still clears on the FIRST absence (control)", async () => {
		const clearSelectedVideoInput = mock(() => undefined);
		const registry = createDeviceRegistry(
			makeDeps({
				getEngineDevices: engineSequence([null, []]),
				getSelectedVideoInput: () => "/dev/video0",
				getRememberedDeviceKind: () => "hdmi",
				clearSelectedVideoInput,
			}),
		);

		await registry.rescan();
		await registry.rescan();

		expect(clearSelectedVideoInput).toHaveBeenCalledTimes(1);
	});
});
