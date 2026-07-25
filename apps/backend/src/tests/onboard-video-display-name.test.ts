import { afterEach, describe, expect, it } from "bun:test";

import type { GetCapabilitiesResult, NetworkIngest } from "@ceraui/rpc/schemas";

import type { LastSeenDevice } from "../helpers/config-schemas.ts";
import { resolveOnboardDisplayName } from "../modules/streaming/audio-naming.ts";
import {
	buildDeviceList,
	fromEngineDevice,
} from "../modules/streaming/devices.ts";
import {
	applyOnboardVideoDisplayRule,
	normalizeOnboardKey,
	resolveOnboardVideoDisplayName,
} from "../modules/streaming/onboard-display-names.ts";
import {
	buildSources,
	getEngineDeviceCache,
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";

type CapabilitySource = GetCapabilitiesResult["sources"][number];

const NO_INGEST: NetworkIngest = { rtmp: null, srt: null };

const HDMI_CAP: CapabilitySource = {
	id: "hdmi",
	supports_audio: false,
	supports_resolution_override: true,
	supports_framerate_override: true,
	default_resolution: "1080p",
	default_framerate: 30,
};

afterEach(() => {
	resetEngineDeviceCache();
});

describe("onboard video display rule", () => {
	it("names every punctuation spelling of the RK3588 HDMI-RX driver id", () => {
		expect(resolveOnboardVideoDisplayName("rk_hdmirx")).toBe("HDMI Input");
		expect(resolveOnboardVideoDisplayName("RK_HDMIRX")).toBe("HDMI Input");
		expect(resolveOnboardVideoDisplayName("rk-hdmirx")).toBe("HDMI Input");
		expect(resolveOnboardVideoDisplayName("rockchip,hdmirx-controller")).toBe(
			"HDMI Input",
		);
	});

	// The engine and the sysfs `Card type` disagree on a ROCK 5B+: cerastream
	// reports `rk_hdmirx`, /sys/class/video4linux/video0/name says `stream_hdmirx`.
	it("names the sysfs Card type the engine-down v4l2 scan reads", () => {
		expect(resolveOnboardVideoDisplayName("stream_hdmirx")).toBe("HDMI Input");
	});

	it("leaves a pluggable device's real product name untouched", () => {
		expect(
			resolveOnboardVideoDisplayName("Elgato Cam Link 4K"),
		).toBeUndefined();
		expect(applyOnboardVideoDisplayRule("RØDE HDMI to USB-C")).toBe(
			"RØDE HDMI to USB-C",
		);
		expect(applyOnboardVideoDisplayRule("Magewell HDMI Capture")).toBe(
			"Magewell HDMI Capture",
		);
	});

	it("is idempotent — the resolved name is not itself a rule key", () => {
		expect(applyOnboardVideoDisplayRule("HDMI Input")).toBe("HDMI Input");
	});

	it("names the video and audio halves of the same physical port identically", () => {
		expect(resolveOnboardVideoDisplayName("rk_hdmirx")).toBe(
			resolveOnboardDisplayName("rockchiphdmiin"),
		);
	});

	it("folds punctuation and case into one key", () => {
		expect(normalizeOnboardKey("rockchip,hdmirx-controller")).toBe(
			"rockchiphdmirxcontroller",
		);
		expect(normalizeOnboardKey("RK_hdmiRX")).toBe("rkhdmirx");
	});
});

describe("fromEngineDevice — display-only rewrite", () => {
	it("renames the onboard HDMI-RX but leaves ids and routing untouched", () => {
		const device = fromEngineDevice({
			input_id: "/dev/video0",
			device_path: "/dev/video0",
			display_name: "rk_hdmirx",
			media_class: "video",
			kind: "hdmi",
			stable_id: "card:rkhdmirx",
		});

		expect(device.display_name).toBe("HDMI Input");
		expect(device.input_id).toBe("/dev/video0");
		expect(device.device_path).toBe("/dev/video0");
		expect(device.stable_id).toBe("card:rkhdmirx");
		expect(device.kind).toBe("hdmi");
	});

	it("still derives the kind from the RAW name when the engine reports none", () => {
		const device = fromEngineDevice({
			input_id: "/dev/video0",
			device_path: "/dev/video0",
			display_name: "rk_hdmirx",
			media_class: "video",
		});
		expect(device.kind).toBe("hdmi");
		expect(device.display_name).toBe("HDMI Input");
	});
});

describe("buildDeviceList — engine-down v4l2 fallback scan", () => {
	it("applies the same rule as the engine path", () => {
		const devices = buildDeviceList(
			[{ card: "video0", name: "rk_hdmirx" }],
			{},
		);
		expect(devices[0]?.display_name).toBe("HDMI Input");
		expect(devices[0]?.input_id).toBe("/dev/video0");
		expect(devices[0]?.kind).toBe("hdmi");
	});
});

describe("sources broadcast — the row the operator actually sees", () => {
	it("carries the clean name on the capture row, never the raw driver id", async () => {
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({
				devices: [
					{
						input_id: "/dev/video0",
						device_path: "/dev/video0",
						display_name: "rk_hdmirx",
						media_class: "video",
						kind: "hdmi",
						caps: [{ width: 1920, height: 1080, framerate: "60" }],
					},
				],
			}),
		});

		const sources = buildSources({
			sources: [HDMI_CAP],
			devices: getEngineDeviceCache(),
			networkIngest: NO_INGEST,
		});

		const capture = sources.find((s) => s.origin === "capture");
		expect(capture?.origin).toBe("capture");
		if (capture?.origin === "capture") {
			expect(capture.displayName).toBe("HDMI Input");
		}
		expect(JSON.stringify(sources)).not.toContain("rk_hdmirx");
	});

	it("names a lost row from a snapshot persisted before the rule existed", () => {
		const lastSeen: LastSeenDevice[] = [
			{
				id: "/dev/video0",
				displayName: "rk_hdmirx",
				kind: "hdmi",
				pipelineId: "hdmi",
				devicePath: "/dev/video0",
			},
		];

		const sources = buildSources({
			sources: [HDMI_CAP],
			devices: [],
			networkIngest: NO_INGEST,
			configSource: "/dev/video0",
			lastSeenDevices: lastSeen,
		});

		const lost = sources.find((s) => s.origin === "capture" && s.lost === true);
		expect(lost?.origin).toBe("capture");
		if (lost?.origin === "capture") {
			expect(lost.displayName).toBe("HDMI Input");
		}
		expect(JSON.stringify(sources)).not.toContain("rk_hdmirx");
	});
});
