/*
 * Mid-stream re-enumeration self-heal (device-quality-wave2).
 *
 * A capture device unplugged and replugged WHILE STREAMING comes back under a
 * NEW node path — the engine still holds the old node open, so the kernel cannot
 * recycle it (confirmed on a Rock 5B+: a RØDE HDMI-to-USB-C moved video1→video2
 * and `config.source` stayed `/dev/video1` forever). Everything downstream
 * matches the persisted id LITERALLY against a row id, so one stale string
 * stranded four operator-facing surfaces at once.
 *
 * Two defects, both covered here:
 *   1. `buildSources` dropped the remembered `lost` row because a live successor
 *      shared its stable identity — even when that successor bridged to no
 *      pipeline and therefore rendered NO row. The device vanished entirely.
 *   2. Nothing ever wrote the recovered id back, so `config.source` kept naming
 *      a node that no longer exists.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type {
	CaptureDevice,
	DeviceKind,
	NetworkIngest,
	StreamSource,
} from "@ceraui/rpc/schemas";

import type { LastSeenDevice } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import {
	buildSources,
	reconcileConfiguredSourceIdentity,
} from "../modules/streaming/sources.ts";

const NO_INGEST: NetworkIngest = { rtmp: null, srt: null };

const RODE_NAME = "RØDE HDMI to USB-C: RØDE HDMI";
const RODE_STABLE_ID = "usb:19f7:0037";

function capSource(id: string) {
	return {
		id,
		supports_audio: false,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
	};
}

function goldenCapSources() {
	return ["hdmi", "usb_mjpeg", "v4l_mjpeg", "camlink", "libuvch264"].map(
		capSource,
	);
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
		media_class: "video",
		kind,
		...(overrides.stable_id !== undefined
			? { stable_id: overrides.stable_id }
			: {}),
	};
}

function lastSeen(
	id: string,
	kind: DeviceKind,
	pipelineId: string,
	overrides: Partial<LastSeenDevice> = {},
): LastSeenDevice {
	return {
		id,
		displayName: overrides.displayName ?? id,
		kind,
		pipelineId,
		devicePath: overrides.devicePath ?? id,
		...(overrides.stableId !== undefined
			? { stableId: overrides.stableId }
			: {}),
	};
}

/** The remembered RØDE, as it was before the replug renumbered it. */
function rodeSnapshot(): LastSeenDevice {
	return lastSeen("/dev/video1", "mjpeg", "usb_mjpeg", {
		displayName: RODE_NAME,
		devicePath: "/dev/video1",
		stableId: RODE_STABLE_ID,
	});
}

function sourcesAfterReplug(successor: CaptureDevice): StreamSource[] {
	const snapshot = rodeSnapshot();
	return buildSources({
		sources: goldenCapSources(),
		devices: [captureDevice("/dev/video0", "hdmi"), successor],
		networkIngest: NO_INGEST,
		configSource: "/dev/video1",
		lastSeenDevices: [snapshot],
		sessionSnapshots: new Map([[snapshot.id, snapshot]]),
	});
}

describe("buildSources — a re-enumerated device never leaves a hole", () => {
	it("migrates the row onto a BRIDGED successor (Todo 34 unchanged)", () => {
		const sources = sourcesAfterReplug(
			captureDevice("/dev/video2", "mjpeg", {
				display_name: RODE_NAME,
				stable_id: RODE_STABLE_ID,
			}),
		);

		expect(sources.filter((s) => s.id === "/dev/video1")).toHaveLength(0);
		const successor = sources.find((s) => s.id === "/dev/video2");
		expect(successor?.origin).toBe("capture");
		expect(successor?.lost).toBeUndefined();
		if (successor?.origin === "capture") {
			expect(successor.displayName).toBe(RODE_NAME);
		}
	});

	it("KEEPS the lost row when the successor bridges to no pipeline", () => {
		// `usb` is exactly what the v4l2 fallback scan's `deriveKind` guesses for a
		// UVC dongle, and it bridges nowhere — so this successor renders no row.
		// Suppressing the `lost` row for it erased the device from the UI outright.
		const sources = sourcesAfterReplug(
			captureDevice("/dev/video2", "usb", {
				display_name: RODE_NAME,
				stable_id: RODE_STABLE_ID,
			}),
		);

		const remembered = sources.find((s) => s.id === "/dev/video1");
		expect(remembered?.origin).toBe("capture");
		expect(remembered?.lost).toBe(true);
		if (remembered?.origin === "capture") {
			expect(remembered.displayName).toBe(RODE_NAME);
		}
	});

	it("still reports a TRUE unplug as lost (no successor to migrate to)", () => {
		const snapshot = rodeSnapshot();
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [captureDevice("/dev/video0", "hdmi")],
			networkIngest: NO_INGEST,
			configSource: "/dev/video1",
			lastSeenDevices: [snapshot],
			sessionSnapshots: new Map([[snapshot.id, snapshot]]),
		});

		expect(sources.find((s) => s.id === "/dev/video1")?.lost).toBe(true);
	});
});

describe("reconcileConfiguredSourceIdentity — the migration is PERSISTED", () => {
	beforeEach(() => {
		const config = getConfig();
		delete config.source;
		delete config.selected_video_input;
		config.last_seen_devices = [];
	});

	it("rewrites config.source AND selected_video_input onto the successor", () => {
		const config = getConfig();
		config.source = "/dev/video1";
		config.selected_video_input = "/dev/video1";
		config.last_seen_devices = [rodeSnapshot()];

		const changed = reconcileConfiguredSourceIdentity(
			sourcesAfterReplug(
				captureDevice("/dev/video2", "mjpeg", {
					display_name: RODE_NAME,
					stable_id: RODE_STABLE_ID,
				}),
			),
		);

		expect(changed).toBe(true);
		expect(getConfig().source).toBe("/dev/video2");
		expect(getConfig().selected_video_input).toBe("/dev/video2");
	});

	it("is a no-op while the configured id still names a row (incl. a lost one)", () => {
		const config = getConfig();
		config.source = "/dev/video1";
		config.last_seen_devices = [rodeSnapshot()];

		const changed = reconcileConfiguredSourceIdentity(
			sourcesAfterReplug(
				captureDevice("/dev/video2", "usb", {
					display_name: RODE_NAME,
					stable_id: RODE_STABLE_ID,
				}),
			),
		);

		expect(changed).toBe(false);
		expect(getConfig().source).toBe("/dev/video1");
	});

	it("NEVER adopts a different device that merely took the free slot", () => {
		const config = getConfig();
		config.source = "/dev/video1";
		config.last_seen_devices = [rodeSnapshot()];

		const snapshot = rodeSnapshot();
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [
				captureDevice("/dev/video2", "mjpeg", {
					display_name: "Some Other Capture Card",
					stable_id: "usb:dead:beef",
				}),
			],
			networkIngest: NO_INGEST,
			configSource: "/dev/video1",
			lastSeenDevices: [snapshot],
			sessionSnapshots: new Map([[snapshot.id, snapshot]]),
		});

		expect(reconcileConfiguredSourceIdentity(sources)).toBe(false);
		expect(getConfig().source).toBe("/dev/video1");
	});

	it("is a no-op when the remembered device carries no stable identity", () => {
		const config = getConfig();
		config.source = "/dev/video1";
		config.last_seen_devices = [
			lastSeen("/dev/video1", "mjpeg", "usb_mjpeg", {
				displayName: RODE_NAME,
				devicePath: "/dev/video1",
			}),
		];

		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [
				captureDevice("/dev/video2", "mjpeg", {
					display_name: RODE_NAME,
					stable_id: RODE_STABLE_ID,
				}),
			],
			networkIngest: NO_INGEST,
			lastSeenDevices: [],
			sessionSnapshots: new Map(),
		});

		expect(reconcileConfiguredSourceIdentity(sources)).toBe(false);
		expect(getConfig().source).toBe("/dev/video1");
	});
});
