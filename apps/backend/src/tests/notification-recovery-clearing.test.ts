/*
 * Raise-only notifications: the two that could never be retracted.
 *
 * A PERSISTENT notification never expires on a timer (`notification-liveness.ts`),
 * so a raise with no matching retraction is permanent. Two of them shipped that
 * way and both were confirmed on a board:
 *
 *   * `hdmi_error` / "No HDMI signal detected" — raised from the RK3588 dmesg line
 *     `hdmirx-controller: Err, timing is invalid`. The kernel prints nothing when
 *     the link relocks, so the notification outlived the outage indefinitely.
 *   * the `cerastream` channel carrying `capture_video_error` — the condition
 *     cleared and the engine went back to idle/healthy, and the error stayed up.
 *
 * Both were also `isDismissable: false`, so there was no manual escape either.
 *
 * These tests pin the retraction on REAL recovery evidence — never a timer — and
 * the negatives that keep it honest.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	GetCapabilitiesResult,
	ListDevicesResult,
	RuntimeErrorEvent,
} from "@ceralive/cerastream";
import { SCHEMA_VERSION } from "@ceralive/cerastream";
import type { CaptureDevice } from "@ceraui/rpc/schemas";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import {
	recheckSourceSignals,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import {
	EMI_ADVISORY_MSG,
	HDMI_ERROR_NOTIFICATION,
	HDMI_NO_SIGNAL_MSG,
	provesHdmiSignalRecovered,
} from "../modules/system/hdmi-signal-notification.ts";
import {
	notificationBroadcast,
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

const HDMI_RX_ID = "/dev/video0";

const LOCKED_1080P5994: ListDevicesResult["devices"][number]["caps"] = [
	{ width: 1920, height: 1080, framerate: "60000/1001" },
];

/** The engine's HDMI-RX entry; `caps` absent is the signal-less shape it emits. */
function hdmiRxEntry(
	caps?: ListDevicesResult["devices"][number]["caps"],
): ListDevicesResult["devices"][number] {
	return {
		input_id: HDMI_RX_ID,
		device_path: HDMI_RX_ID,
		display_name: "rk_hdmirx",
		media_class: "video",
		kind: "hdmi",
		stable_id: "port:fdee0000.hdmirx-controller",
		...(caps !== undefined ? { caps } : {}),
	};
}

/** A USB capture dongle: it can carry a picture without saying anything at all
 *  about the board's HDMI-RX port. */
function usbDongleEntry(): ListDevicesResult["devices"][number] {
	return {
		input_id: "/dev/video3",
		device_path: "/dev/video3",
		display_name: "RØDE HDMI to USB-C: RØDE HDMI",
		media_class: "video",
		kind: "uvc_h264",
		caps: LOCKED_1080P5994,
	};
}

/** The local v4l2 scan's view: the node is present either way. */
function observedHdmiRx(): CaptureDevice[] {
	return [
		{
			input_id: HDMI_RX_ID,
			device_path: HDMI_RX_ID,
			display_name: "HDMI Input",
			media_class: "video",
			kind: "hdmi",
		},
	];
}

function recordingClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

async function captureFrames(
	run: () => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
	const sink: string[] = [];
	const client = recordingClient(sink);
	addClient(client);
	try {
		await run();
	} finally {
		removeClient(client);
	}
	return sink.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function removedIds(frames: Array<Record<string, unknown>>): string[] {
	return frames.flatMap((frame) => {
		const payload = frame.notification as
			| { remove?: Array<{ id: string }> }
			| undefined;
		return (payload?.remove ?? []).map((entry) => entry.id);
	});
}

async function seedHdmiCaps(): Promise<void> {
	const caps: GetCapabilitiesResult = {
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
				id: "hdmi",
				supports_audio: false,
				supports_resolution_override: true,
				supports_framerate_override: true,
				default_resolution: "1080p",
				default_framerate: 30,
			},
		],
	};
	await getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
}

function raiseNoHdmiSignal(): void {
	notificationBroadcast(
		HDMI_ERROR_NOTIFICATION,
		"error",
		HDMI_NO_SIGNAL_MSG,
		3,
		true,
		true,
	);
}

/** The OTHER claim on the same channel, raised exactly as `sensors.ts` raises it. */
function raiseEmiAdvisory(): void {
	notificationBroadcast(
		HDMI_ERROR_NOTIFICATION,
		"error",
		EMI_ADVISORY_MSG,
		8,
		true,
		true,
		true,
		"notifications.hdmiError",
	);
}

function probe(
	devices: ListDevicesResult["devices"],
): Promise<void> | ReturnType<typeof recheckSourceSignals> {
	return recheckSourceSignals(observedHdmiRx(), {
		fetchEngineDevices: async () => ({ devices }),
	});
}

describe("provesHdmiSignalRecovered — the pure verdict", () => {
	test("an HDMI receiver reporting a locked signal is recovery", () => {
		expect(
			provesHdmiSignalRecovered([{ kind: "hdmi", signal: "present" }]),
		).toBe(true);
	});

	test("a severed link, an unprobed row and an empty list are all NOT recovery", () => {
		expect(
			provesHdmiSignalRecovered([{ kind: "hdmi", signal: "absent" }]),
		).toBe(false);
		expect(
			provesHdmiSignalRecovered([{ kind: "hdmi", signal: "unknown" }]),
		).toBe(false);
		expect(provesHdmiSignalRecovered([{ kind: "hdmi" }])).toBe(false);
		expect(provesHdmiSignalRecovered([])).toBe(false);
	});

	test("another device carrying a picture says nothing about the HDMI-RX port", () => {
		expect(
			provesHdmiSignalRecovered([
				{ kind: "usb", signal: "present" },
				{ kind: "uvc_h264", signal: "present" },
				{ kind: "hdmi", signal: "absent" },
			]),
		).toBe(false);
	});
});

describe("hdmi_error clears when the HDMI link relocks", () => {
	beforeEach(async () => {
		notificationRemove(HDMI_ERROR_NOTIFICATION);
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
		await seedHdmiCaps();
	});

	afterEach(() => {
		notificationRemove(HDMI_ERROR_NOTIFICATION);
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
	});

	test("it survives every recheck for as long as the link is genuinely severed", async () => {
		raiseNoHdmiSignal();

		await probe([hdmiRxEntry()]);
		await probe([hdmiRxEntry()]);

		expect(notificationExists(HDMI_ERROR_NOTIFICATION)?.msg).toBe(
			HDMI_NO_SIGNAL_MSG,
		);
	});

	test("an unreachable engine leaves it standing — absence of news is not recovery", async () => {
		raiseNoHdmiSignal();

		await recheckSourceSignals(observedHdmiRx(), {
			fetchEngineDevices: async () => {
				throw new Error("engine unreachable");
			},
		});

		expect(notificationExists(HDMI_ERROR_NOTIFICATION)).toBeDefined();
	});

	test("the locked-signal probe retracts it AND pushes a remove frame to connected clients", async () => {
		raiseNoHdmiSignal();
		await probe([hdmiRxEntry()]);
		expect(notificationExists(HDMI_ERROR_NOTIFICATION)).toBeDefined();

		const frames = await captureFrames(() =>
			Promise.resolve(probe([hdmiRxEntry(LOCKED_1080P5994)])),
		);

		expect(removedIds(frames)).toContain(HDMI_ERROR_NOTIFICATION);
		expect(notificationExists(HDMI_ERROR_NOTIFICATION)).toBeUndefined();
	});

	test("a different device's picture never retracts it", async () => {
		raiseNoHdmiSignal();

		await probe([hdmiRxEntry(), usbDongleEntry()]);

		expect(notificationExists(HDMI_ERROR_NOTIFICATION)).toBeDefined();
	});

	/*
	 * DELIBERATE POLICY CHANGE — this test previously asserted the opposite
	 * ("the EMI/cable advisory sharing the name is left alone — it is a different
	 * claim"). The advisory was exempted from retraction on the reading that it
	 * describes CABLE QUALITY, which a relocked link does not falsify.
	 *
	 * Operators reported the consequence: "an infinite notification for something
	 * that is already corrected". The two kernel lines behind the advisory
	 * (`hdmirx_wait_lock_and_get_timing signal not lock`, `hdmirx_delayed_work_audio:
	 * audio underflow`) are printed during ORDINARY link locking — a plain
	 * unplug/replug cycle emits them — not only during a sustained fault. With no
	 * retraction path and no timer expiry, a routine cable swap left the advisory
	 * standing for the rest of the session.
	 *
	 * An engine-authored `signal: "present"` on the HDMI-RX port is a positive
	 * statement that the port is carrying a picture, and that falsifies BOTH claims
	 * on this channel equally. The retraction is therefore symmetric now.
	 */
	test("the EMI/cable advisory sharing the name is retracted by the same evidence", async () => {
		raiseEmiAdvisory();

		const frames = await captureFrames(() =>
			Promise.resolve(probe([hdmiRxEntry(LOCKED_1080P5994)])),
		);

		expect(removedIds(frames)).toContain(HDMI_ERROR_NOTIFICATION);
		expect(notificationExists(HDMI_ERROR_NOTIFICATION)).toBeUndefined();
	});

	test("a severed link leaves the advisory standing, exactly like the no-signal claim", async () => {
		raiseEmiAdvisory();

		await probe([hdmiRxEntry()]);
		await probe([hdmiRxEntry()]);

		expect(notificationExists(HDMI_ERROR_NOTIFICATION)?.msg).toBe(
			EMI_ADVISORY_MSG,
		);
	});

	test("a different device's picture never retracts the advisory either", async () => {
		raiseEmiAdvisory();

		await probe([hdmiRxEntry(), usbDongleEntry()]);

		expect(notificationExists(HDMI_ERROR_NOTIFICATION)?.msg).toBe(
			EMI_ADVISORY_MSG,
		);
	});

	test("a healthy device set with nothing standing broadcasts no removal at all", async () => {
		const frames = await captureFrames(() =>
			Promise.resolve(probe([hdmiRxEntry(LOCKED_1080P5994)])),
		);

		expect(removedIds(frames)).toHaveLength(0);
	});
});

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

interface EngineHarness {
	backend: CerastreamBackend;
	notified: Array<{ name: string; msg: string; isDismissable: boolean }>;
	removed: string[];
}

function makeEngineHarness(): EngineHarness {
	const notified: Array<{
		name: string;
		msg: string;
		isDismissable: boolean;
	}> = [];
	const removed: string[] = [];
	const backend = new CerastreamBackend({
		connect: async () => {
			throw new Error("connect is unused on the event path");
		},
		connectOptions: {},
		getConfig: () => ({}) as RuntimeConfig,
		saveConfig: () => {},
		bridge: {
			notify: (name, _type, msg, _duration, _isPersistent, isDismissable) => {
				notified.push({ name, msg, isDismissable });
			},
			notificationExists: () => false,
			removeNotification: (name) => {
				removed.push(name);
			},
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-notification-recovery.json",
		logger: silentLogger,
	});
	return { backend, notified, removed };
}

function engineError(code: string): RuntimeErrorEvent {
	return {
		type: "error",
		seq: 0,
		code,
		source: "engine",
	} as unknown as RuntimeErrorEvent;
}

function statusEvent(
	state: string,
	streaming: boolean,
): Parameters<CerastreamBackend["handleEvent"]>[0] {
	return {
		type: "status",
		seq: 1,
		state,
		streaming,
	} as Parameters<CerastreamBackend["handleEvent"]>[0];
}

describe("capture_video_error clears when the engine proves capture is healthy", () => {
	test("it is raised dismissable, so the operator is never trapped by it", () => {
		const { backend, notified } = makeEngineHarness();

		backend.handleEvent(engineError("capture_video_error"));

		expect(notified).toHaveLength(1);
		expect(notified[0]?.name).toBe("cerastream");
		expect(notified[0]?.msg).toBe(
			"Capture card error (video). No automatic restart is scheduled.",
		);
		expect(notified[0]?.isDismissable).toBe(true);
	});

	test("an idle engine is NOT proof — idle only means not streaming", () => {
		const { backend, removed } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error"));

		backend.handleEvent(statusEvent("idle", false));
		backend.handleEvent(statusEvent("starting", false));

		expect(removed).toHaveLength(0);
	});

	test("a concordant streaming status frame retracts it", () => {
		const { backend, removed } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error"));

		backend.handleEvent(statusEvent("streaming", true));

		expect(removed).toEqual(["cerastream"]);
	});

	test("a repeated healthy heartbeat does not re-emit the removal", () => {
		const { backend, removed } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error"));

		backend.handleEvent(statusEvent("streaming", true));
		backend.handleEvent(statusEvent("streaming", true));
		backend.handleEvent(statusEvent("streaming", true));

		expect(removed).toEqual(["cerastream"]);
	});

	test("a new session start does not inherit the previous session's failure", async () => {
		const { backend, removed } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error"));

		await backend
			.start({} as RuntimeConfig, {} as never)
			.catch(() => undefined);

		expect(removed).toEqual(["cerastream"]);
	});

	test("an engine error whose recovery signal is not established stays latched", () => {
		for (const code of [
			"capture_audio_error",
			"pipeline_stall",
			"srt_connection_lost",
		]) {
			const { backend, removed } = makeEngineHarness();
			backend.handleEvent(engineError(code));

			backend.handleEvent(statusEvent("streaming", true));

			expect(removed).toEqual([]);
		}
	});

	test("a later error occupying the shared slot is not retracted by the earlier one's recovery", () => {
		const { backend, removed } = makeEngineHarness();
		backend.handleEvent(engineError("capture_video_error"));
		backend.handleEvent(engineError("srt_connection_lost"));

		backend.handleEvent(statusEvent("streaming", true));

		expect(removed).toEqual([]);
	});

	test("nothing standing means nothing removed", () => {
		const { backend, removed } = makeEngineHarness();

		backend.handleEvent(statusEvent("streaming", true));

		expect(removed).toEqual([]);
	});
});
