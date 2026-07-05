import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { type ListDevicesResult, SCHEMA_VERSION } from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO, type SwitchInputOutput } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { logger } from "../helpers/logger.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	AudioProbeTimeoutError,
	asrcProbe,
	clearAsrcProbeReject,
	setMockAudioDevicesProvider,
} from "../modules/streaming/audio.ts";
import {
	buildAutoLaunchConfig,
	getPendingAudioFollowAsrc,
	getResolvedAsrc,
	getResolvedAsrcReason,
	resetAutoAudioState,
	resolveAutoAsrcFromLiveState,
	setAutoAudioBroadcaster,
	setPendingAudioFollowAsrc,
	setResolvedAsrcFromStart,
} from "../modules/streaming/auto-audio.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import { cerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import { deviceRegistry } from "../modules/streaming/devices.ts";
import {
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { stop as streamStop } from "../modules/streaming/streamloop/session.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import {
	applySwitchInputFollow,
	streamingStopProcedure,
	switchInputProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function captureClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

/** The `config` payloads a captured client received (the config broadcast). */
function configPayloads(sink: string[]): RuntimeConfig[] {
	return sink
		.map((raw) => JSON.parse(raw))
		.filter(
			(obj): obj is { config: RuntimeConfig } =>
				!!obj && typeof obj === "object" && "config" in obj,
		)
		.map((obj) => obj.config);
}

/**
 * Seed one bridged UVC capture source ("usb-cam-1") plus a matching engine audio
 * entry, so `getSourcesMessage()` resolves the switch target and Auto resolves USB
 * audio (the canonical HDMI→USB scenario). Mirrors auto-audio.test.ts's seed.
 */
async function seedUsbCaptureSource(): Promise<void> {
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
	await refreshEngineDeviceCache({
		fetchEngineDevices: async () =>
			({
				devices: [
					{
						input_id: "usb-cam-1",
						device_path: "/dev/video1",
						display_name: "USB Streamer",
						media_class: "video",
						kind: "uvc_h264",
					},
					{
						input_id: "usb-audio-1",
						device_path: "",
						display_name: "RØDE AI-Micro",
						media_class: "audio",
						kind: "audio",
						alsa_card_id: "Micro",
					},
				],
			}) as unknown as ListDevicesResult,
	});
}

const switchOk = (activeInput: string, gapMs = 8): SwitchInputOutput => ({
	success: true,
	active_input: activeInput,
	gap_ms: gapMs,
});

// ─── applySwitchInputFollow — the T7 logic ───────────────────────────────────

describe("applySwitchInputFollow — durable switch + deferred auto-audio follow", () => {
	let broadcasts: Array<Record<string, unknown>>;
	let sink: string[];
	let client: AppWebSocket;

	beforeEach(async () => {
		resetAutoAudioState();
		updateStatus(false);
		clearCapabilitiesCache();
		resetEngineDeviceCache();
		await seedUsbCaptureSource();
		setMockAudioDevicesProvider(() => ({ "USB audio": "usbaudio" }));
		broadcasts = [];
		setAutoAudioBroadcaster((u) =>
			broadcasts.push(u as Record<string, unknown>),
		);
		sink = [];
		client = captureClient(sink);
		addClient(client);
	});

	afterEach(() => {
		removeClient(client);
		setAutoAudioBroadcaster(undefined);
		setMockAudioDevicesProvider(undefined);
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		resetAutoAudioState();
		updateStatus(false);
		delete getConfig().asrc;
		delete getConfig().source;
		delete getConfig().pipeline;
		delete getConfig().selected_video_input;
	});

	test("(1) HDMI→USB with Auto: persists USB routing, freezes resolved_asrc, broadcasts pending, hints follow", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "hdmi";
		// The running stream is on HDMI audio.
		setResolvedAsrcFromStart("HDMI", "hdmi");
		broadcasts = [];

		const out = applySwitchInputFollow("usb-cam-1", switchOk("usb-cam-1"));

		// (a) source persisted to the USB routing (+ config broadcast).
		expect(getConfig().source).toBe("usb-cam-1");
		expect(getConfig().pipeline).toBe("libuvch264");
		expect(getConfig().selected_video_input).toBe("usb-cam-1");
		const configs = configPayloads(sink);
		expect(configs).toHaveLength(1);
		expect(configs[0]?.source).toBe("usb-cam-1");
		expect(configs[0]?.pipeline).toBe("libuvch264");
		expect(configs[0]?.selected_video_input).toBe("usb-cam-1");

		// (b) resolved_asrc UNCHANGED — the running stream still uses HDMI audio.
		expect(getResolvedAsrc()).toBe("HDMI");
		expect(getResolvedAsrcReason()).toBe("hdmi");

		// (c) pending target broadcast once; output carries the follow hint.
		expect(getPendingAudioFollowAsrc()).toBe("USB audio");
		expect(broadcasts).toEqual([{ pending_audio_follow_asrc: "USB audio" }]);
		expect(out.audio_follow_pending).toBe(true);
		expect(out.success).toBe(true);
		expect(out.active_input).toBe("usb-cam-1");
	});

	test("(1-tail) the next start resolves the persisted USB source → applies USB audio, clears pending, updates resolved_asrc", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "hdmi";
		setResolvedAsrcFromStart("HDMI", "hdmi");
		applySwitchInputFollow("usb-cam-1", switchOk("usb-cam-1"));
		expect(getPendingAudioFollowAsrc()).toBe("USB audio");
		broadcasts = [];

		// Reproduce start-stream.ts resolveLaunchConfig (no source override): the
		// launch resolves the now-persisted source and applies it at start.
		const resolution = resolveAutoAsrcFromLiveState();
		setResolvedAsrcFromStart(resolution.asrcKey, resolution.reason);
		const launch = buildAutoLaunchConfig(getConfig(), resolution);

		expect(launch.asrc).toBe("USB audio");
		expect(getResolvedAsrc()).toBe("USB audio");
		expect(getResolvedAsrcReason()).toBe("usb-alias");
		expect(getPendingAudioFollowAsrc()).toBeNull();
		// The persisted config keeps the "Auto" sentinel by construction.
		expect(getConfig().asrc).toBe(AUDIO_SOURCE_AUTO);
	});

	test("(2) explicit (non-Auto) asrc: source persistence still happens, pending untouched, no follow hint", () => {
		getConfig().asrc = "USB audio";
		getConfig().source = "hdmi";

		const out = applySwitchInputFollow("usb-cam-1", switchOk("usb-cam-1"));

		expect(getConfig().source).toBe("usb-cam-1");
		expect(getConfig().pipeline).toBe("libuvch264");
		expect(getConfig().selected_video_input).toBe("usb-cam-1");
		expect(configPayloads(sink)).toHaveLength(1);

		expect(getPendingAudioFollowAsrc()).toBeNull();
		expect(broadcasts).toEqual([]);
		expect(out.audio_follow_pending).toBeUndefined();
	});

	test("(3) no-op same-key: next resolution equals current resolved_asrc → no pending broadcast, field absent", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "hdmi";
		// The running stream is ALREADY on USB audio.
		setResolvedAsrcFromStart("USB audio", "usb-alias");
		broadcasts = [];

		const out = applySwitchInputFollow("usb-cam-1", switchOk("usb-cam-1"));

		// The switch is still persisted…
		expect(getConfig().source).toBe("usb-cam-1");
		expect(configPayloads(sink)).toHaveLength(1);
		// …but the re-resolved target is unchanged → no pending follow.
		expect(getPendingAudioFollowAsrc()).toBeNull();
		expect(broadcasts).toEqual([]);
		expect(out.audio_follow_pending).toBeUndefined();
	});

	test("(4) cerastreamBackend.switchAudio is NEVER invoked from the switchInput follow path", () => {
		const switchAudioSpy = spyOn(cerastreamBackend, "switchAudio");
		try {
			getConfig().asrc = AUDIO_SOURCE_AUTO;
			getConfig().source = "hdmi";
			setResolvedAsrcFromStart("HDMI", "hdmi");

			const out = applySwitchInputFollow("usb-cam-1", switchOk("usb-cam-1"));

			expect(out.audio_follow_pending).toBe(true);
			expect(switchAudioSpy).not.toHaveBeenCalled();
		} finally {
			switchAudioSpy.mockRestore();
		}
	});

	test("(6) unresolvable input_id: passthrough, NO config write, one debug log", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "hdmi-existing";
		getConfig().pipeline = "existing-pipeline";
		const debugSpy = spyOn(logger, "debug");
		try {
			const result = switchOk("ghost-input");
			const out = applySwitchInputFollow("ghost-input", result);

			expect(out).toBe(result);
			expect(out.audio_follow_pending).toBeUndefined();
			// No persistence, no config broadcast, no pending follow.
			expect(getConfig().source).toBe("hdmi-existing");
			expect(getConfig().pipeline).toBe("existing-pipeline");
			expect(configPayloads(sink)).toHaveLength(0);
			expect(getPendingAudioFollowAsrc()).toBeNull();
			expect(broadcasts).toEqual([]);
			expect(debugSpy).toHaveBeenCalledWith(
				expect.stringContaining("not a known source"),
				expect.objectContaining({ input_id: "ghost-input" }),
			);
		} finally {
			debugSpy.mockRestore();
		}
	});

	test("a FAILED video switch is passed through untouched (no persistence, no follow)", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "hdmi-existing";
		const result: SwitchInputOutput = {
			success: false,
			error: "SOURCE_LOST",
		};

		const out = applySwitchInputFollow("usb-cam-1", result);

		expect(out).toBe(result);
		expect(getConfig().source).toBe("hdmi-existing");
		expect(configPayloads(sink)).toHaveLength(0);
		expect(getPendingAudioFollowAsrc()).toBeNull();
		expect(broadcasts).toEqual([]);
	});

	test("end-to-end wiring: switchInputProcedure awaits the switch then applies the follow", async () => {
		const realSwitchInput = deviceRegistry.switchInput;
		deviceRegistry.switchInput = async (inputId: string) =>
			switchOk(inputId, 12);
		try {
			getConfig().asrc = AUDIO_SOURCE_AUTO;
			getConfig().source = "hdmi";
			setResolvedAsrcFromStart("HDMI", "hdmi");
			broadcasts = [];

			const out = await call(
				switchInputProcedure,
				{ input_id: "usb-cam-1" },
				{ context: makeContext() },
			);

			expect(out.success).toBe(true);
			expect(out.audio_follow_pending).toBe(true);
			expect(getConfig().source).toBe("usb-cam-1");
			expect(getConfig().pipeline).toBe("libuvch264");
			expect(getPendingAudioFollowAsrc()).toBe("USB audio");
		} finally {
			deviceRegistry.switchInput = realSwitchInput;
		}
	});
});

// ─── (5) Stop clears the pending follow — BOTH surfaces, independently ────────

describe("stop clears pending_audio_follow_asrc — real stop path (streamloop)", () => {
	let broadcasts: Array<Record<string, unknown>>;

	beforeEach(() => {
		resetAutoAudioState();
		updateStatus(false);
		broadcasts = [];
		setAutoAudioBroadcaster((u) =>
			broadcasts.push(u as Record<string, unknown>),
		);
	});
	afterEach(() => {
		setAutoAudioBroadcaster(undefined);
		resetAutoAudioState();
		updateStatus(false);
	});

	afterEach(() => {
		clearAsrcProbeReject();
	});

	test("(5a) streamloop stop() clears the pending follow to null with one broadcast", async () => {
		setPendingAudioFollowAsrc("USB audio");
		// Arm an asrc-probe reject so stop() returns via its early-return branch: it
		// never reaches getStreamingBackend().stop()/stopAll(), whose deferred
		// software-update poll would otherwise spawn an async apt-get whose log line
		// leaks into an unrelated test. stop() rejects the probe as it clears it.
		const probe = asrcProbe("__t7_absent_audio_card__");
		broadcasts = [];

		streamStop();

		expect(getPendingAudioFollowAsrc()).toBeNull();
		expect(broadcasts).toEqual([{ pending_audio_follow_asrc: null }]);
		const probeError = await probe.catch((err: unknown) => err);
		expect(probeError).toBeInstanceOf(AudioProbeTimeoutError);
	});
});

describe("stop clears pending_audio_follow_asrc — mock stop branch (streaming.procedure)", () => {
	let broadcasts: Array<Record<string, unknown>>;
	let savedNodeEnv: string | undefined;

	beforeEach(() => {
		savedNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		initMockService("caps-full");
		resetAutoAudioState();
		updateStatus(false);
		broadcasts = [];
		setAutoAudioBroadcaster((u) =>
			broadcasts.push(u as Record<string, unknown>),
		);
	});
	afterEach(() => {
		setAutoAudioBroadcaster(undefined);
		resetAutoAudioState();
		updateStatus(false);
		stopMockService();
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("(5b) the mock stop branch clears the pending follow to null with one broadcast", async () => {
		setPendingAudioFollowAsrc("USB audio");
		broadcasts = [];

		const out = await call(streamingStopProcedure, undefined, {
			context: makeContext(),
		});

		expect(out.success).toBe(true);
		expect(getPendingAudioFollowAsrc()).toBeNull();
		expect(broadcasts).toEqual([{ pending_audio_follow_asrc: null }]);
	});
});
