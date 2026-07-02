import { describe, expect, mock, test } from "bun:test";

import type { CaptureDevice } from "@ceraui/rpc/schemas";
import {
	createDeviceRegistry,
	type DeviceRegistryDeps,
	deriveKind,
	fromEngineDevice,
	mapEngineDeviceKind,
} from "../modules/streaming/devices.ts";

// Engine-off deps: force the v4l2 fallback path unless a test overrides
// getEngineDevices. Every effectful collaborator is a silent stub.
function makeDeps(
	overrides: Partial<DeviceRegistryDeps> = {},
): Partial<DeviceRegistryDeps> {
	return {
		listVideoCards: async () => [],
		readCardName: async () => undefined,
		getAudioSources: () => ({}),
		getEngine: () => "cerastream",
		isStreaming: () => false,
		engineSwitch: async () => undefined,
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

describe("deriveKind — USB/UVC never mislabeled HDMI (acceptance fixtures)", () => {
	test('"RØDE HDMI to USB-C: RØDE HDMI" → usb (was wrongly hdmi)', () => {
		expect(deriveKind("RØDE HDMI to USB-C: RØDE HDMI")).toBe("usb");
	});

	test('"USB3 HDMI Capture" → usb', () => {
		expect(deriveKind("USB3 HDMI Capture")).toBe("usb");
	});

	test('"rk_hdmirx" → hdmi (real HDMI-RX must stay hdmi)', () => {
		expect(deriveKind("rk_hdmirx")).toBe("hdmi");
	});
});

describe("mapEngineDeviceKind — engine kind is authoritative when present", () => {
	test("engine kind wins over the display-name heuristic", () => {
		// A name that WOULD heuristically be "hdmi", but the engine typed it uvc.
		expect(mapEngineDeviceKind("uvc_h264", "Some HDMI Capture")).toBe(
			"uvc_h264",
		);
		expect(mapEngineDeviceKind("uvc_h265", "whatever")).toBe("uvc_h265");
		expect(mapEngineDeviceKind("camlink", "no keyword")).toBe("camlink");
		expect(mapEngineDeviceKind("mjpeg", "x")).toBe("mjpeg");
		expect(mapEngineDeviceKind("hdmi", "RØDE HDMI to USB-C")).toBe("hdmi");
	});

	test("unknown engine kind collapses to other", () => {
		expect(mapEngineDeviceKind("future_kind", "RØDE HDMI to USB-C")).toBe(
			"other",
		);
	});

	test("absent kind falls back to the heuristic", () => {
		expect(mapEngineDeviceKind(undefined, "RØDE HDMI to USB-C")).toBe("usb");
		expect(mapEngineDeviceKind(undefined, "rk_hdmirx")).toBe("hdmi");
	});
});

describe("fromEngineDevice — verbatim ids, typed kinds, no heuristic", () => {
	test("carries engine ids verbatim and applies the typed kind", () => {
		const device = fromEngineDevice({
			input_id: "/dev/video0",
			device_path: "/dev/video0",
			display_name: "Elgato HDMI Grabber",
			media_class: "video",
			kind: "uvc_h264",
		});
		expect(device).toEqual({
			input_id: "/dev/video0",
			device_path: "/dev/video0",
			display_name: "Elgato HDMI Grabber",
			media_class: "video",
			kind: "uvc_h264",
		});
	});

	test("passes caps through when present", () => {
		const device = fromEngineDevice({
			input_id: "/dev/video1",
			device_path: "/dev/video1",
			display_name: "cam",
			media_class: "video",
			kind: "mjpeg",
			caps: [{ width: 1920, height: 1080, media_type: "image/jpeg" }],
		});
		expect(device.caps).toEqual([
			{ width: 1920, height: 1080, media_type: "image/jpeg" },
		]);
	});
});

describe("device registry — engine-as-source", () => {
	test("uses engine devices (ids + typed kinds) verbatim, no heuristic", async () => {
		const engineDevices: CaptureDevice[] = [
			{
				input_id: "/dev/video0",
				device_path: "/dev/video0",
				display_name: "Elgato HDMI Grabber",
				media_class: "video",
				kind: "uvc_h264",
			},
		];
		const registry = createDeviceRegistry(
			makeDeps({ getEngineDevices: async () => engineDevices }),
		);
		const devices = await registry.scan();
		expect(devices).toEqual(engineDevices);
		// The engine kind (uvc_h264) survives — the "HDMI" name did NOT flip it.
		expect(devices[0]?.kind).toBe("uvc_h264");
	});

	test("falls back to the v4l2 scan when the engine is unreachable", async () => {
		const registry = createDeviceRegistry(
			makeDeps({
				getEngineDevices: async () => null,
				listVideoCards: async () => ["video0"],
				readCardName: async () => "RØDE HDMI to USB-C: RØDE HDMI",
			}),
		);
		const devices = await registry.scan();
		// Path-form id (matches the engine id scheme), heuristic kind → usb.
		expect(devices[0]?.input_id).toBe("/dev/video0");
		expect(devices[0]?.kind).toBe("usb");
	});
});

describe("device registry — engine-up reconciliation", () => {
	test("clears a stale persisted selection + notifies on engine-up transition", async () => {
		const clearSelectedVideoInput = mock(() => undefined);
		const notify = mock(() => undefined);
		let engineReachable = false;
		const registry = createDeviceRegistry(
			makeDeps({
				getEngineDevices: async () =>
					engineReachable
						? [
								{
									input_id: "/dev/video0",
									device_path: "/dev/video0",
									display_name: "cam",
									media_class: "video",
									kind: "uvc_h264",
								},
							]
						: null,
				getSelectedVideoInput: () => "/dev/video99",
				clearSelectedVideoInput,
				notify,
			}),
		);

		// First scan: engine unreachable → v4l2 fallback, no reconcile yet.
		await registry.scan();
		expect(clearSelectedVideoInput).toHaveBeenCalledTimes(0);

		// Engine comes up: transition triggers reconcile of the stale selection.
		engineReachable = true;
		await registry.scan();
		expect(clearSelectedVideoInput).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[1]).toBe("warning");
	});

	test("keeps a still-valid persisted selection on engine-up", async () => {
		const clearSelectedVideoInput = mock(() => undefined);
		const notify = mock(() => undefined);
		const registry = createDeviceRegistry(
			makeDeps({
				getEngineDevices: async () => [
					{
						input_id: "/dev/video0",
						device_path: "/dev/video0",
						display_name: "cam",
						media_class: "video",
						kind: "uvc_h264",
					},
				],
				getSelectedVideoInput: () => "/dev/video0",
				clearSelectedVideoInput,
				notify,
			}),
		);
		await registry.scan();
		expect(clearSelectedVideoInput).toHaveBeenCalledTimes(0);
		expect(notify).toHaveBeenCalledTimes(0);
	});
});

describe("device registry — id/switch-input contract (either source)", () => {
	// A fake engine switch-input that accepts an id ONLY if it is one of the
	// devices the engine advertised (mirrors cerastream's DeviceNotFound gate).
	function fakeEngineSwitch(accepted: Set<string>) {
		return async (inputId: string): Promise<void> => {
			if (!accepted.has(inputId)) throw new Error("DeviceNotFound");
		};
	}

	test("engine-sourced ids are accepted by the fake engine switch-input", async () => {
		const accepted = new Set(["/dev/video0"]);
		const registry = createDeviceRegistry(
			makeDeps({
				isStreaming: () => true,
				engineSwitch: fakeEngineSwitch(accepted),
				getEngineDevices: async () => [
					{
						input_id: "/dev/video0",
						device_path: "/dev/video0",
						display_name: "cam",
						media_class: "video",
						kind: "uvc_h264",
					},
				],
			}),
		);
		const result = await registry.switchInput("/dev/video0");
		expect(result.success).toBe(true);
		expect(result.active_input).toBe("/dev/video0");
	});

	test("v4l2-fallback ids are accepted by the fake engine switch-input", async () => {
		const accepted = new Set(["/dev/video63"]);
		const registry = createDeviceRegistry(
			makeDeps({
				isStreaming: () => true,
				engineSwitch: fakeEngineSwitch(accepted),
				getEngineDevices: async () => null,
				listVideoCards: async () => ["video63"],
				readCardName: async () => "QA-Cam",
			}),
		);
		const result = await registry.switchInput("/dev/video63");
		expect(result.success).toBe(true);
		expect(result.active_input).toBe("/dev/video63");
	});
});
