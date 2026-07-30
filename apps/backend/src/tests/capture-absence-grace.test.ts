/*
 * The transient libuvc-rebind gap must not surface as "no audio device".
 *
 * Root cause (board session 2026-07-30 17:20 UTC, `192.168.78.131`): libuvc's
 * reattach guard rebinds USB interfaces `1.0`/`1.1` around every open/close of a
 * UVC-H.264 camera. That is a NORMAL, necessary part of the detach-recovery
 * mechanism — no USB device reset, no `devnum` change, and the camera's ALSA card
 * never moves. But on RELEASE there is a real window (measured ≈400 ms, bounded
 * above by 2.0 s) in which the engine has already dropped its `held_devices`
 * record and has NOT yet rediscovered the re-registered node. During it,
 * `list-devices` returns the camera's audio row and NOT its video row.
 *
 * `resolveAutoAsrcFromLiveState()` resolves `asrc: "Auto"` by looking the VIDEO
 * source up first and joining it to its own audio card on `physical_group_id`
 * (rule 5). With the video row missing — or present but restored from the local
 * `/dev` scan, which carries no `physical_group_id` — the join has nothing to
 * match, so Auto resolved to `no-same-device-audio`, the meter preference went
 * `null`, and the operator read "Meter unavailable · No audio device" for a
 * camera whose microphone was bound and streaming the entire time.
 *
 * These fixtures drive the REAL live-state resolver across that window.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type ListDevicesResult, SCHEMA_VERSION } from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO, type StreamSource } from "@ceraui/rpc/schemas";

import { getConfig } from "../modules/config.ts";
import { setMockAudioDevicesProvider } from "../modules/streaming/audio.ts";
import {
	resetAutoAudioState,
	resolveAutoAsrcFromLiveState,
} from "../modules/streaming/auto-audio.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	CAPTURE_ABSENCE_GRACE_MS,
	isCaptureAbsenceGraceActive,
	resetCapturePresence,
	resolveSelectedSourceWithGrace,
	setCapturePresenceClockForTest,
} from "../modules/streaming/capture-presence.ts";
import {
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";

// ─── Fixtures: the DJI Osmo Pocket 3 topology measured on the board ──────────
//
// Video and audio sit on DIFFERENT USB interfaces of ONE physical device, so
// both rows carry the same `physical_group_id` (`usb:5-1` on the board).

const CAMERA_GROUP = "usb:5-1";
const CAMERA_ID = "/dev/video1";
const CAMERA_STABLE_ID = "usb:2ca3:0023:DJI_DJIPocket3_123456789ABCDEF";

type EngineDevice = Record<string, unknown>;

function cameraVideoRow(withGroup: boolean): EngineDevice {
	return {
		input_id: CAMERA_ID,
		device_path: CAMERA_ID,
		display_name: "DJIPocket3: OsmoPocket3",
		media_class: "video",
		kind: "uvc_h264",
		stable_id: CAMERA_STABLE_ID,
		...(withGroup ? { physical_group_id: CAMERA_GROUP } : {}),
	};
}

const CAMERA_AUDIO_ROW: EngineDevice = {
	input_id: "audio:DJIPocket3",
	device_path: "",
	display_name: "DJI DJIPocket3",
	media_class: "audio",
	kind: "audio",
	alsa_card_id: "DJIPocket3",
	physical_group_id: CAMERA_GROUP,
};

async function seedCapabilities(): Promise<void> {
	await getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: {
				platform: {
					supports_h265: true,
					hardware_accelerated: true,
					max_resolution: "1080p",
				},
				encoder: {
					codecs: ["h264"],
					bitrate_range: { min: 500, max: 20000, unit: "kbps" },
				},
				sources: [
					{
						id: "libuvch264",
						supports_audio: true,
						supports_resolution_override: true,
						supports_framerate_override: true,
						default_resolution: "1080p",
						default_framerate: 30,
					},
				],
			},
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
}

/** Commit ONE engine view into the device cache the sources builder reads. */
async function commitEngineView(
	devices: readonly EngineDevice[],
): Promise<void> {
	await refreshEngineDeviceCache({
		fetchEngineDevices: async () =>
			({ devices: [...devices] }) as unknown as ListDevicesResult,
	});
}

/** The healthy steady state: camera video + its own audio card, both grouped. */
const HEALTHY_VIEW = [cameraVideoRow(true), CAMERA_AUDIO_ROW];

/**
 * The RELEASE gap: the engine dropped its held video record and has not yet
 * rediscovered the successor node. Audio never moves — that is the whole point.
 */
const GAP_VIEW_VIDEO_ABSENT = [CAMERA_AUDIO_ROW];

/**
 * The other half of the same window: the `/dev` scan HAS seen the node come back,
 * so CeraUI's hotplug merge restores the row from `lastEngineVideoDevices` — which
 * deliberately restores durable IDENTITY (`kind`/`stable_id`) and NEVER the
 * same-moment `physical_group_id`. The row is present and useless to rule 5.
 */
const GAP_VIEW_GROUP_STRIPPED = [cameraVideoRow(false), CAMERA_AUDIO_ROW];

describe("Auto audio — absence hysteresis across a libuvc interface rebind", () => {
	let clockMs: number;

	beforeEach(async () => {
		clockMs = 1_000_000;
		setCapturePresenceClockForTest(() => clockMs);
		resetAutoAudioState();
		updateStatus(false);
		clearCapabilitiesCache();
		resetEngineDeviceCache();
		await seedCapabilities();
		setMockAudioDevicesProvider(() => ({ "DJI DJIPocket3": "DJIPocket3" }));
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = CAMERA_ID;
	});

	afterEach(() => {
		setCapturePresenceClockForTest(undefined);
		setMockAudioDevicesProvider(undefined);
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		resetAutoAudioState();
		updateStatus(false);
		delete getConfig().asrc;
		delete getConfig().source;
		delete getConfig().last_seen_devices;
	});

	test("baseline: the healthy view resolves Auto to the camera's OWN card", async () => {
		await commitEngineView(HEALTHY_VIEW);
		const r = resolveAutoAsrcFromLiveState();
		expect(r.reason).toBe("usb-same-device");
		expect(r.asrcKey).toBe("DJI DJIPocket3");
		expect(r.cardId).toBe("DJIPocket3");
	});

	test("the video row VANISHING for < 2 s keeps the same-device resolution", async () => {
		await commitEngineView(HEALTHY_VIEW);
		expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");

		await commitEngineView(GAP_VIEW_VIDEO_ABSENT);
		const during = resolveAutoAsrcFromLiveState();
		expect(during.reason).toBe("usb-same-device");
		expect(during.asrcKey).toBe("DJI DJIPocket3");
	});

	test("a restored row STRIPPED of its physical_group_id keeps the resolution", async () => {
		await commitEngineView(HEALTHY_VIEW);
		expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");

		await commitEngineView(GAP_VIEW_GROUP_STRIPPED);
		const during = resolveAutoAsrcFromLiveState();
		expect(during.reason).toBe("usb-same-device");
		expect(during.asrcKey).toBe("DJI DJIPocket3");
	});

	test("the successor node re-registers and resolution follows it, no stale hold", async () => {
		await commitEngineView(HEALTHY_VIEW);
		resolveAutoAsrcFromLiveState();
		await commitEngineView(GAP_VIEW_VIDEO_ABSENT);
		expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");

		await commitEngineView(HEALTHY_VIEW);
		const after = resolveAutoAsrcFromLiveState();
		expect(after.reason).toBe("usb-same-device");
		expect(after.asrcKey).toBe("DJI DJIPocket3");
	});

	// ─── NEGATIVE CONTROL: a real unplug must still be reported ──────────────

	test("a SUSTAINED absence past the window resolves honestly again", async () => {
		await commitEngineView(HEALTHY_VIEW);
		expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");

		await commitEngineView(GAP_VIEW_VIDEO_ABSENT);
		expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");

		clockMs += CAPTURE_ABSENCE_GRACE_MS + 1;
		const after = resolveAutoAsrcFromLiveState();
		expect(after.reason).toBe("no-same-device-audio");
		expect(after.asrcKey).toBeNull();
	});

	test("a repeatedly-observed absence cannot RENEW the window", async () => {
		await commitEngineView(HEALTHY_VIEW);
		resolveAutoAsrcFromLiveState();
		await commitEngineView(GAP_VIEW_VIDEO_ABSENT);

		// Poll the whole window at the audio meter's own 5 Hz cadence: the run is
		// continuous, so every one of these observations extends nothing.
		for (let elapsed = 0; elapsed <= CAPTURE_ABSENCE_GRACE_MS; elapsed += 200) {
			expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");
			clockMs += 200;
		}
		expect(resolveAutoAsrcFromLiveState().reason).toBe("no-same-device-audio");
	});

	test("the camera's own audio is still refused once it, too, is gone", async () => {
		await commitEngineView(HEALTHY_VIEW);
		resolveAutoAsrcFromLiveState();

		// A true unplug takes BOTH interfaces with it — the libuvc rebind never did.
		await commitEngineView([]);
		clockMs += CAPTURE_ABSENCE_GRACE_MS + 1;
		const after = resolveAutoAsrcFromLiveState();
		expect(after.asrcKey).toBeNull();
		expect(after.cardId).toBeNull();
	});
});

// ─── The pure verdict, driven directly ───────────────────────────────────────

function captureRow(overrides: Partial<StreamSource> = {}): StreamSource {
	return {
		id: CAMERA_ID,
		pipelineId: "libuvch264",
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable",
		available: true,
		origin: "capture",
		kind: "uvc_h264",
		displayName: "DJIPocket3: OsmoPocket3",
		devicePath: CAMERA_ID,
		stableId: CAMERA_STABLE_ID,
		physicalGroupId: CAMERA_GROUP,
		...overrides,
	} as StreamSource;
}

describe("resolveSelectedSourceWithGrace — the bounded verdict", () => {
	beforeEach(() => resetCapturePresence());
	afterEach(() => resetCapturePresence());

	test("holds at the window boundary and releases one millisecond past it", () => {
		const healthy = [captureRow()];
		expect(resolveSelectedSourceWithGrace(CAMERA_ID, healthy, 0)).toBe(
			healthy[0] as StreamSource,
		);

		expect(resolveSelectedSourceWithGrace(CAMERA_ID, [], 100)?.id).toBe(
			CAMERA_ID,
		);
		expect(
			resolveSelectedSourceWithGrace(
				CAMERA_ID,
				[],
				100 + CAPTURE_ABSENCE_GRACE_MS,
			),
		).toBeDefined();
		expect(
			resolveSelectedSourceWithGrace(
				CAMERA_ID,
				[],
				100 + CAPTURE_ABSENCE_GRACE_MS + 1,
			),
		).toBeUndefined();
		expect(isCaptureAbsenceGraceActive()).toBe(false);
	});

	test("a `lost` row is a degradation, not a healthy observation", () => {
		resolveSelectedSourceWithGrace(CAMERA_ID, [captureRow()], 0);
		const lost = [captureRow({ available: false, lost: true })];
		expect(
			resolveSelectedSourceWithGrace(CAMERA_ID, lost, 500)?.physicalGroupId,
		).toBe(CAMERA_GROUP);
		expect(resolveSelectedSourceWithGrace(CAMERA_ID, lost, 5_000)?.lost).toBe(
			true,
		);
	});

	test("a DIFFERENT device on the freed node never inherits the memory", () => {
		resolveSelectedSourceWithGrace(CAMERA_ID, [captureRow()], 0);
		const intruder = captureRow({
			stableId: "usb:1234:5678:OTHER",
			displayName: "RØDE HDMI to USB-C",
			physicalGroupId: undefined,
		});
		const resolved = resolveSelectedSourceWithGrace(CAMERA_ID, [intruder], 100);
		expect(resolved).toBe(intruder);
		expect(resolved?.physicalGroupId).toBeUndefined();
		expect(isCaptureAbsenceGraceActive()).toBe(false);
	});

	test("the memory follows the device across a renumber, by stable identity", () => {
		resolveSelectedSourceWithGrace(CAMERA_ID, [captureRow()], 0);
		const successor = captureRow({
			id: "/dev/video2",
			devicePath: "/dev/video2",
			previousIds: [CAMERA_ID],
			physicalGroupId: undefined,
		});
		expect(
			resolveSelectedSourceWithGrace("/dev/video2", [successor], 100)
				?.physicalGroupId,
		).toBe(CAMERA_GROUP);
	});

	test("a coarse selection holds nothing — it is an offering, not a device", () => {
		resolveSelectedSourceWithGrace(CAMERA_ID, [captureRow()], 0);
		const coarse = {
			id: "hdmi",
			pipelineId: "hdmi",
			modes: [],
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
			audioKind: "selectable",
			available: true,
			origin: "coarse",
			labelKey: "settings.sources.hdmi",
		} as StreamSource;
		expect(resolveSelectedSourceWithGrace("hdmi", [coarse], 100)).toBe(coarse);
		expect(isCaptureAbsenceGraceActive()).toBe(false);
		// The camera's memory is gone with it, so its next absence starts cold.
		expect(resolveSelectedSourceWithGrace(CAMERA_ID, [], 200)).toBeUndefined();
	});

	test("an unset selection resolves to nothing and forgets", () => {
		resolveSelectedSourceWithGrace(CAMERA_ID, [captureRow()], 0);
		expect(resolveSelectedSourceWithGrace(undefined, [], 10)).toBeUndefined();
		expect(resolveSelectedSourceWithGrace(CAMERA_ID, [], 20)).toBeUndefined();
	});
});
