/*
 * CHARACTERIZATION — the two audio/HDMI transient-honesty behaviours whose
 * SHIPPED contract had no direct lock (device-platform-wave4 todo 15).
 *
 * Both behaviours ALREADY EXIST on `origin/main` (commit `63a833d9`) and both are
 * already well covered where it is easy to cover them:
 *   • the bounded absence grace   → `capture-absence-grace.test.ts` (17 cases)
 *   • the selection-scoped raise  → `hdmi-raise-scope.test.ts` (14 cases)
 *   • the periodic signal recheck → `hdmi-signal-recheck.test.ts` (12 cases)
 *
 * What none of them locks is the part a refactor actually breaks:
 *
 *   A. The grace is documented as read by `resolveAutoAsrcFromLiveState` AND
 *      NOTHING ELSE — "the device list, the `lost` row and routing are
 *      untouched". Every existing case asserts the RESOLUTION; none asserts the
 *      NON-effect. A future author widening the hold into `buildSources` would
 *      leave all 17 green while re-introducing exactly the stale-device-row class
 *      the grace was scoped narrow to avoid.
 *
 *   B. `hdmi-raise-scope.test.ts` INJECTS `noSignalRaiseAllowed`, so the
 *      production predicate that computes it (`sensors.ts`
 *      `hdmiNoSignalRaiseAllowed` — module-private, reads the real config +
 *      the real `sources` view, documented FAIL-OPEN) is never executed by a
 *      test. Its wiring is the half that shipped to the board.
 *
 * These tests drive the REAL production paths, with no injected seam for the
 * behaviour under test. They are characterization: they must be GREEN on the
 * tree that shipped them, and nothing here breaks a landed behaviour to force a
 * red.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	type CerastreamClient,
	type ListDevicesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";

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
	getSourcesMessage,
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	HDMI_ERROR_NOTIFICATION,
	HDMI_NO_SIGNAL_MSG,
} from "../modules/system/hdmi-signal-notification.ts";
import { handleRk3588HdmiDmesg } from "../modules/system/sensors.ts";
import {
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";

const NO_SIGNAL_LINE =
	"[  812.443001] hdmirx-controller: Err, timing is invalid\n";

const OSMO_GROUP = "usb:5-1";

type EngineDevice = Record<string, unknown>;

const OSMO_VIDEO: EngineDevice = {
	input_id: "/dev/video1",
	device_path: "/dev/video1",
	display_name: "DJIPocket3: OsmoPocket3",
	media_class: "video",
	kind: "uvc_h264",
	stable_id: "usb:2ca3:0023",
	physical_group_id: OSMO_GROUP,
};

const OSMO_AUDIO: EngineDevice = {
	input_id: "osmo-audio",
	device_path: "",
	display_name: "DJIPocket3",
	media_class: "audio",
	kind: "audio",
	alsa_card_id: "DJIPocket3",
	physical_group_id: OSMO_GROUP,
};

const HDMI_RX: EngineDevice = {
	input_id: "/dev/video0",
	device_path: "/dev/video0",
	display_name: "rk_hdmirx",
	media_class: "video",
	kind: "hdmi",
	stable_id: "port:fdee0000.hdmirx-controller",
	caps: [
		{
			media_type: "video/x-raw",
			width: 1920,
			height: 1080,
			framerate: "60000/1001",
		},
	],
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
					{
						id: "hdmi",
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

async function observeDevices(devices: EngineDevice[]): Promise<void> {
	await refreshEngineDeviceCache({
		fetchEngineDevices: async () =>
			({ devices }) as unknown as ListDevicesResult,
	} as unknown as { client?: CerastreamClient });
}

function healthyCaptureRowIds(): string[] {
	return getSourcesMessage()
		.sources.filter((s) => s.origin === "capture" && s.lost !== true)
		.map((s) => s.id);
}

function lostRowIds(): string[] {
	return getSourcesMessage()
		.sources.filter((s) => s.lost === true)
		.map((s) => s.id);
}

describe("A. the absence grace holds the VERDICT and nothing else", () => {
	beforeEach(async () => {
		resetAutoAudioState();
		updateStatus(false);
		clearCapabilitiesCache();
		resetEngineDeviceCache();
		await seedCapabilities();
		setMockAudioDevicesProvider(() => ({ DJIPocket3: "DJIPocket3" }));
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "/dev/video1";
		getConfig().last_streamed_source = "/dev/video1";
	});
	afterEach(() => {
		setMockAudioDevicesProvider(undefined);
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		resetAutoAudioState();
		updateStatus(false);
		delete getConfig().asrc;
		delete getConfig().source;
		delete getConfig().last_streamed_source;
	});

	test("baseline: the healthy view resolves the camera to its OWN card", async () => {
		await observeDevices([OSMO_VIDEO, OSMO_AUDIO]);
		expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");
		expect(healthyCaptureRowIds()).toContain("/dev/video1");
	});

	// The whole point of the narrow scope. During the libuvc release window the
	// AUDIO verdict is held — but the operator's device list must keep telling the
	// truth about what the engine can currently see, or a stale row outlives the
	// hardware exactly as it did before the grace existed.
	test("while the verdict is HELD, the sources view still reports the absence", async () => {
		await observeDevices([OSMO_VIDEO, OSMO_AUDIO]);
		expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");
		expect(healthyCaptureRowIds()).toContain("/dev/video1");

		await observeDevices([HDMI_RX, OSMO_AUDIO]);

		expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");
		expect(healthyCaptureRowIds()).not.toContain("/dev/video1");
		expect(lostRowIds()).toContain("/dev/video1");
	});

	test("and the held verdict never suppresses the row's own `lost` state", async () => {
		await observeDevices([OSMO_VIDEO, OSMO_AUDIO]);
		resolveAutoAsrcFromLiveState();

		getConfig().last_seen_devices = [
			{
				id: "/dev/video1",
				displayName: "DJIPocket3: OsmoPocket3",
				kind: "uvc_h264",
				pipelineId: "libuvch264",
				devicePath: "/dev/video1",
				stableId: "usb:2ca3:0023",
			},
		];
		await observeDevices([HDMI_RX, OSMO_AUDIO]);

		expect(resolveAutoAsrcFromLiveState().reason).toBe("usb-same-device");
		expect(lostRowIds()).toContain("/dev/video1");
		delete getConfig().last_seen_devices;
	});
});

describe("B. the PRODUCTION no-signal raise predicate, with no injected seam", () => {
	beforeEach(async () => {
		clearCapabilitiesCache();
		resetEngineDeviceCache();
		await seedCapabilities();
		notificationRemove(HDMI_ERROR_NOTIFICATION);
	});
	afterEach(() => {
		notificationRemove(HDMI_ERROR_NOTIFICATION);
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		delete getConfig().source;
		delete getConfig().last_streamed_source;
	});

	function standingHdmiMessage(): string | undefined {
		return notificationExists(HDMI_ERROR_NOTIFICATION)?.msg;
	}

	// The exact board sequence: a `streaming.start` sweep opens `/dev/video0` on
	// behalf of an operator streaming the Osmo, the kernel prints the line, and
	// the operator must see NOTHING about HDMI.
	test("a USB-camera selection suppresses the incidental sweep's raise", async () => {
		await observeDevices([OSMO_VIDEO, HDMI_RX]);
		getConfig().source = "/dev/video1";

		handleRk3588HdmiDmesg(NO_SIGNAL_LINE);

		expect(standingHdmiMessage()).toBeUndefined();
	});

	// The negative control that keeps the gate suppression-only: the operator IS
	// watching the HDMI port, so a real no-signal fault must still be reported.
	test("an HDMI selection still raises — the gate only ever withholds", async () => {
		await observeDevices([OSMO_VIDEO, HDMI_RX]);
		getConfig().source = "/dev/video0";

		handleRk3588HdmiDmesg(NO_SIGNAL_LINE);

		expect(standingHdmiMessage()).toBe(HDMI_NO_SIGNAL_MSG);
	});

	// FAIL-OPEN: absence of evidence is not evidence. An unset selection cannot
	// prove the operator is looking elsewhere, so the fault is reported.
	test("no selection at all is not evidence, so the raise stands", async () => {
		await observeDevices([OSMO_VIDEO, HDMI_RX]);
		delete getConfig().source;
		delete getConfig().last_streamed_source;

		handleRk3588HdmiDmesg(NO_SIGNAL_LINE);

		expect(standingHdmiMessage()).toBe(HDMI_NO_SIGNAL_MSG);
	});
});
