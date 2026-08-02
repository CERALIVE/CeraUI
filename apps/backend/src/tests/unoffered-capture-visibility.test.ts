/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { describe, expect, it } from "bun:test";
import type { GetCapabilitiesResult } from "@ceralive/cerastream";
import type {
	CaptureDevice,
	DeviceKind,
	NetworkIngest,
} from "@ceraui/rpc/schemas";
import { streamSourceSchema } from "@ceraui/rpc/schemas";
import { applyOnboardVideoDisplayRule } from "../modules/streaming/onboard-display-names.ts";
import { buildSources } from "../modules/streaming/sources.ts";

type CapabilitySource = GetCapabilitiesResult["sources"][number];

const PIPELINE_NOT_OFFERED_REASON = "live.education.reason.pipelineNotOffered";

const NO_INGEST: NetworkIngest = { rtmp: null, srt: null };

function capSource(id: string): CapabilitySource {
	return {
		id,
		supports_audio: false,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
	};
}

function captureDevice(
	input_id: string,
	kind: DeviceKind,
	overrides: Partial<CaptureDevice> = {},
): CaptureDevice {
	return {
		input_id,
		device_path: overrides.device_path ?? input_id,
		display_name: overrides.display_name ?? input_id,
		media_class: overrides.media_class ?? "video",
		kind,
		...(overrides.stable_id !== undefined
			? { stable_id: overrides.stable_id }
			: {}),
		...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
	};
}

/**
 * The EXACT payload a Rock 5B+ published while running the released cerastream
 * 2026.7.2 (schema 0.4.0): a capability catalog naming the retired `camlink` /
 * `v4l_mjpeg` pipeline ids, and two genuinely-connected cameras whose kinds
 * bridge to `hdmi` / `usb_mjpeg`. The intersection is EMPTY.
 */
const LEGACY_ENGINE_CAP_SOURCES: CapabilitySource[] = [
	capSource("camlink"),
	capSource("v4l_mjpeg"),
	capSource("test"),
];

function boardDevices(): CaptureDevice[] {
	return [
		captureDevice("/dev/video1", "hdmi", {
			display_name: "snps_hdmirx",
			signal: "present",
			stable_id: "port:platform:fdee0000.hdmi_receiver",
		}),
		captureDevice("/dev/video5", "mjpeg", {
			display_name: "RØDE HDMI to USB-C: RØDE HDMI",
			signal: "present",
			stable_id: "usb:19f7:0080:OC0001967",
		}),
	];
}

describe("a live capture device is never silently dropped (board regression)", () => {
	it("renders BOTH cameras when the engine offers neither of their pipelines", () => {
		const sources = buildSources({
			sources: LEGACY_ENGINE_CAP_SOURCES,
			devices: boardDevices(),
			networkIngest: NO_INGEST,
		});

		const ids = sources.map((s) => s.id);
		expect(ids).toContain("/dev/video1");
		expect(ids).toContain("/dev/video5");
	});

	it("was the ONLY row before the fix — the picker collapsed to the test pattern", () => {
		const sources = buildSources({
			sources: LEGACY_ENGINE_CAP_SOURCES,
			devices: boardDevices(),
			networkIngest: NO_INGEST,
		});

		// The regression this locks: `test` alone is what the board actually served.
		expect(sources.map((s) => s.id)).not.toEqual(["test"]);
	});

	it("marks them unavailable with the engine-support reason, never selectable", () => {
		const sources = buildSources({
			sources: LEGACY_ENGINE_CAP_SOURCES,
			devices: boardDevices(),
			networkIngest: NO_INGEST,
		});

		for (const id of ["/dev/video1", "/dev/video5"]) {
			const row = sources.find((s) => s.id === id);
			expect(row?.available).toBe(false);
			expect(row?.unavailableReason).toBe(PIPELINE_NOT_OFFERED_REASON);
			expect(row?.origin).toBe("capture");
		}
	});

	it("claims no capability it cannot back — no audio, no overrides, no ladder", () => {
		const row = buildSources({
			sources: LEGACY_ENGINE_CAP_SOURCES,
			devices: boardDevices(),
			networkIngest: NO_INGEST,
		}).find((s) => s.id === "/dev/video1");

		expect(row?.supportsAudio).toBe(false);
		expect(row?.audioKind).toBe("none");
		expect(row?.supportsResolutionOverride).toBe(false);
		expect(row?.supportsFramerateOverride).toBe(false);
		expect(row?.modes).toEqual([]);
	});

	it("keeps the engine-authored identity + signal so the operator can tell WHICH device", () => {
		const row = buildSources({
			sources: LEGACY_ENGINE_CAP_SOURCES,
			devices: boardDevices(),
			networkIngest: NO_INGEST,
		}).find((s) => s.id === "/dev/video1");

		expect(row?.origin).toBe("capture");
		if (row?.origin !== "capture") throw new Error("expected a capture row");
		expect(row.kind).toBe("hdmi");
		expect(row.signal).toBe("present");
		expect(row.devicePath).toBe("/dev/video1");
		expect(row.stableId).toBe("port:platform:fdee0000.hdmi_receiver");
	});

	it("emits rows that satisfy the published wire schema", () => {
		const sources = buildSources({
			sources: LEGACY_ENGINE_CAP_SOURCES,
			devices: boardDevices(),
			networkIngest: NO_INGEST,
		});

		for (const row of sources) {
			expect(() => streamSourceSchema.parse(row)).not.toThrow();
		}
	});
});

describe("the fallback is scoped — it never invents a row", () => {
	it("still drops SoC codec/scaler nodes that bridge to no video pipeline", () => {
		const sources = buildSources({
			sources: LEGACY_ENGINE_CAP_SOURCES,
			devices: [
				captureDevice("/dev/video0", "other", { display_name: "rockchip-rga" }),
				captureDevice("/dev/video2", "other", {
					display_name: "rockchip,rk3568-vpu-dec",
				}),
			],
			networkIngest: NO_INGEST,
		});

		expect(sources.some((s) => s.id === "/dev/video0")).toBe(false);
		expect(sources.some((s) => s.id === "/dev/video2")).toBe(false);
	});

	it("still ignores audio-class devices", () => {
		const sources = buildSources({
			sources: LEGACY_ENGINE_CAP_SOURCES,
			devices: [captureDevice("audio:card0", "hdmi", { media_class: "audio" })],
			networkIngest: NO_INGEST,
		});

		expect(sources.some((s) => s.id === "audio:card0")).toBe(false);
	});

	it("a test-kind device stays the ONE virtual row — it is already represented", () => {
		const sources = buildSources({
			sources: LEGACY_ENGINE_CAP_SOURCES,
			devices: [captureDevice("videotest", "test")],
			networkIngest: NO_INGEST,
		});

		expect(sources.filter((s) => s.origin === "virtual")).toHaveLength(1);
		expect(sources.some((s) => s.origin === "capture")).toBe(false);
	});

	it("a network-backed row is likewise never duplicated as a capture row", () => {
		const sources = buildSources({
			sources: [capSource("rtmp"), capSource("test")],
			devices: [captureDevice("/dev/video9", "network")],
			networkIngest: NO_INGEST,
		});

		expect(sources.some((s) => s.origin === "capture")).toBe(false);
	});

	it("a device whose pipeline IS offered keeps the normal available row", () => {
		const sources = buildSources({
			sources: [capSource("hdmi"), capSource("test")],
			devices: [captureDevice("/dev/video1", "hdmi")],
			networkIngest: NO_INGEST,
		});

		const row = sources.find((s) => s.id === "/dev/video1");
		expect(row?.available).toBe(true);
		expect(row?.unavailableReason).toBeUndefined();
	});

	it("does not reorder or displace the rows an offered engine already produced", () => {
		const offered = [capSource("hdmi"), capSource("test")];
		const withoutUnoffered = buildSources({
			sources: offered,
			devices: [captureDevice("/dev/video1", "hdmi")],
			networkIngest: NO_INGEST,
		}).map((s) => s.id);

		const withUnoffered = buildSources({
			sources: offered,
			devices: [
				captureDevice("/dev/video1", "hdmi"),
				captureDevice("/dev/video5", "mjpeg"),
			],
			networkIngest: NO_INGEST,
		}).map((s) => s.id);

		expect(withUnoffered.slice(0, withoutUnoffered.length)).toEqual(
			withoutUnoffered,
		);
		expect(withUnoffered.at(-1)).toBe("/dev/video5");
	});
});

describe("the HDMI-RX node is named for the operator, not for the driver", () => {
	it("resolves the v4l2 DRIVER name the current engine reports", () => {
		expect(applyOnboardVideoDisplayRule("snps_hdmirx")).toBe("HDMI Input");
	});

	it("still resolves the card-type and legacy engine spellings", () => {
		expect(applyOnboardVideoDisplayRule("stream_hdmirx")).toBe("HDMI Input");
		expect(applyOnboardVideoDisplayRule("rk_hdmirx")).toBe("HDMI Input");
		expect(applyOnboardVideoDisplayRule("rockchip,hdmirx-controller")).toBe(
			"HDMI Input",
		);
	});

	it("leaves a real product name untouched", () => {
		expect(applyOnboardVideoDisplayRule("RØDE HDMI to USB-C: RØDE HDMI")).toBe(
			"RØDE HDMI to USB-C: RØDE HDMI",
		);
	});

	it("is idempotent", () => {
		expect(applyOnboardVideoDisplayRule("HDMI Input")).toBe("HDMI Input");
	});
});
