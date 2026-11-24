/**
 * Every setting that can be cleared, through each writer that clears or sets
 * it: an open tab hears of it at that write, not at some later broadcast. A
 * `config` alone means the write cleared nothing.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type {
	AddonDescriptor,
	StreamingSetConfigInput,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { namespacedRelayId } from "../helpers/config-schemas.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { setMockNetworkIngestActive } from "../mocks/providers/network-ingest.ts";
import { getConfig, saveConfig, setConfigFilePath } from "../modules/config.ts";
import { setPersistentBondOptOut } from "../modules/network/bond-preference.ts";
import { refreshNetworkIngestInfo } from "../modules/network/network-ingest.ts";
import {
	forceRepairMigration,
	setRemoteConfig,
} from "../modules/remote/remote.ts";
import {
	handleRemoteRelays,
	updateCachedRelays,
} from "../modules/remote/remote-relays.ts";
import {
	handleIngestSlots,
	resetIngestSlots,
	selectIngestSlot,
} from "../modules/remote-control/ingest-slots.ts";
import { PROTOCOL_VERSION } from "../modules/remote-control/protocol.ts";
import {
	handleSelfFencingOp,
	resetSelfFencingState,
} from "../modules/remote-control/self-fencing.ts";
import {
	handleSetProfile,
	resetSetProfile,
} from "../modules/remote-control/set-profile.ts";
import { wireSetProfile } from "../modules/remote-control/set-profile-wiring.ts";
import {
	reconcileConfiguredAudioIdentity,
	setMockAudioDevicesProvider,
} from "../modules/streaming/audio.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import { setApplyNowGateForTest } from "../modules/streaming/config-change-bridge.ts";
import { reconcileInflightConfigChange } from "../modules/streaming/config-change-persistence.ts";
import { clearStagedConfigChange } from "../modules/streaming/config-change-staging.ts";
import { createDeviceRegistry } from "../modules/streaming/devices.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import {
	applyObservedEngineDevices,
	broadcastSources,
	noteStreamedSourceCommitted,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { updateConfig, updateStatus } from "../modules/streaming/streaming.ts";
import { setAutostart } from "../modules/streaming/streamloop/autostart.ts";
import {
	kioskStart,
	kioskStop,
	stopKioskPolling,
} from "../modules/system/kiosk.ts";
import { persistWifiCountry } from "../modules/wifi/wifi-country.ts";
import { broadcastConfig } from "../rpc/config-broadcast.ts";
import { setAudioMixProcedure } from "../rpc/procedures/audio-mix.procedure.ts";
import {
	applySwitchInputFollow,
	setBitrateProcedure,
	setConfigProcedure,
	setSourceVisibilityProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import {
	attachHuaweiTwins,
	installHuaweiIdentityResolver,
	makeRpcContext,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";
import { useConfigClient } from "./helpers/config-client.ts";
import { OSMO_STABLE, osmo } from "./helpers/dual-mode-camera.ts";

const { tab, frames, heardFrom } = useConfigClient();
const cleared = (...keys: string[]) => ["config", { keys }];
const named = () =>
	new Set(
		frames().flatMap(
			(frame) =>
				(frame.config_clear as { keys: string[] } | undefined)?.keys ?? [],
		),
	);
/** The last config the tab was sent, and the one the device holds. */
const told = () => frames().findLast((frame) => "config" in frame)?.config;
const stored = () => JSON.parse(JSON.stringify(getConfig()));
const setConfig = (input: StreamingSetConfigInput) => () =>
	call(setConfigProcedure, input, { context: makeRpcContext() });

const source = (id: string, overrides = true) => ({
	id,
	supports_audio: true,
	supports_resolution_override: overrides,
	supports_framerate_override: overrides,
	default_resolution: "1080p",
	default_framerate: 30,
});
const CAPS: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	// `rtmp` honors neither geometry axis: what is published decides.
	sources: [
		source("hdmi"),
		source("libuvch264"),
		source("usb_mjpeg"),
		source("rtmp", false),
	],
	network_embedded_audio: true,
	audio_mix: {
		max_inputs: 4,
		max_tracks: 4,
		gain_db_min: -60,
		gain_db_max: 12,
		delay_ms_max: 2000,
	},
};
const MIX = {
	id: "Primary",
	tracks: [1],
	gain_db: 0,
	mute: false,
	delay_ms: 0,
};

describe("through the streaming writers", () => {
	const savedMode = process.env.MOCK_MODE;

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await engine(["composition", "composition-geometry"]);
	});

	async function engine(features: string[]): Promise<void> {
		clearCapabilitiesCache();
		await initPipelines({
			fetchEngineCapabilities: async () => ({
				caps: { ...CAPS, features },
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
		});
	}

	beforeEach(async () => {
		setMockNetworkIngestActive("rtmp", true);
		await refreshNetworkIngestInfo();
		setMockAudioDevicesProvider(() => ({ Primary: "hw:CARD=primary" }));
		updateStatus(false);
		applyObservedEngineDevices([osmo("osmo")]);
	});

	afterEach(async () => {
		setMockNetworkIngestActive("rtmp", false);
		await refreshNetworkIngestInfo();
		setMockAudioDevicesProvider(undefined);
		resetEngineDeviceCache();
	});

	afterAll(async () => {
		stopMockService();
		clearCapabilitiesCache();
		await initPipelines();
		if (savedMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMode;
	});

	const rows: Array<
		[string, Record<string, unknown>, () => unknown, unknown[]]
	> = [
		[
			"audio_inputs: the mixer unmutes a default primary",
			{ asrc: "Primary", audio_inputs: [{ ...MIX, mute: true }] },
			() =>
				call(
					setAudioMixProcedure,
					{ id: "Primary", mute: false },
					{ context: makeRpcContext() },
				),
			cleared("audio_inputs"),
		],
		[
			"audio_inputs: the mixer removes the last extra track",
			{ asrc: "Primary", audio_inputs: [{ ...MIX, tracks: [1, 2] }] },
			() =>
				call(
					setAudioMixProcedure,
					{ id: "Primary", track: { number: 2, on: false } },
					{ context: makeRpcContext() },
				),
			cleared("audio_inputs"),
		],
		[
			"video_codec: Encoder Automatic",
			{ video_codec: "h264" },
			setConfig({ video_codec: null }),
			cleared("video_codec"),
		],
		[
			"composition: picture-in-picture off",
			{
				composition: {
					secondary_input_id: "video1",
					layout: "pip-top-left",
					alpha: 1,
				},
			},
			setConfig({ composition: null }),
			cleared("composition"),
		],
		[
			"selected_video_input, input_mode, source_stable_id: a switch to a network source",
			{
				source: "osmo",
				selected_video_input: "osmo",
				input_mode: "uvc_h264",
				source_stable_id: "usb:2ca3:0023:SN-A",
			},
			setConfig({ source: "rtmp" }),
			cleared("selected_video_input", "input_mode", "source_stable_id"),
		],
		[
			"resolution, framerate: a pipeline that honors neither override",
			{ pipeline: "hdmi", resolution: "1080p", framerate: 30 },
			setConfig({ pipeline: "rtmp" }),
			cleared("resolution", "framerate"),
		],
		[
			"relay_server, selected_ingest_endpoint: a manual destination",
			{ relay_server: "r1", selected_ingest_endpoint: "ep-1" },
			setConfig({ srtla_addr: "127.0.0.1", srtla_port: 5000 }),
			cleared("relay_server", "selected_ingest_endpoint"),
		],
		[
			"srtla_addr, srtla_port, selected_ingest_endpoint: a relay destination",
			{
				srtla_addr: "127.0.0.1",
				srtla_port: 5000,
				selected_ingest_endpoint: "ep-1",
			},
			setConfig({ relay_server: "r1" }),
			cleared("srtla_addr", "srtla_port", "selected_ingest_endpoint"),
		],
		[
			"srt_streamid: a relay account",
			{ srt_streamid: "s" },
			setConfig({ relay_account: "a" }),
			cleared("srt_streamid"),
		],
		[
			"relay_account: a manual stream id",
			{ relay_account: "a" },
			setConfig({ srt_streamid: "s" }),
			cleared("relay_account"),
		],
		[
			"selected_ingest_endpoint: no managed slot",
			{ selected_ingest_endpoint: "ep-1" },
			setConfig({ selected_ingest_endpoint: "" }),
			cleared("selected_ingest_endpoint"),
		],
		[
			"relay_server, relay_account: a start on a manual destination",
			{
				pipeline: "hdmi",
				max_br: 5000,
				srt_latency: 2000,
				bitrate_overlay: false,
				delay: 0,
				asrc: "Primary",
				relay_server: "r1",
				relay_account: "a1",
			},
			() =>
				updateConfig({
					srtla_addr: "127.0.0.1",
					srtla_port: 5000,
					srt_streamid: "s",
				}),
			cleared("relay_server", "relay_account"),
		],
		[
			"selected_video_input: a live switch to an input with none",
			{ source: "osmo", selected_video_input: "osmo", asrc: "Primary" },
			() =>
				applySwitchInputFollow("rtmp", {
					success: true,
					active_input: "rtmp",
					gap_ms: 1,
				}),
			cleared("selected_video_input"),
		],
	];
	for (const [name, config, write, expected] of rows)
		test(name, async () => {
			Object.assign(getConfig(), config);

			expect(await heardFrom(write)).toEqual(expected);
			expect(told()).toEqual(stored());
		});

	const START = {
		pipeline: "hdmi",
		max_br: 5000,
		srt_latency: 2000,
		bitrate_overlay: false,
		delay: 0,
		asrc: "Primary",
		srtla_addr: "127.0.0.1",
		srtla_port: 5000,
		srt_streamid: "s",
	};
	const PIP = {
		secondary_input_id: "video1",
		layout: "pip-top-left",
		alpha: 1,
	} as const;
	const sets: Array<[string, Record<string, unknown>, () => unknown, object]> =
		[
			[
				"audio_inputs: the mixer mutes a default primary",
				{ asrc: "Primary" },
				() =>
					call(
						setAudioMixProcedure,
						{ id: "Primary", mute: true },
						{ context: makeRpcContext() },
					),
				{ audio_inputs: [{ ...MIX, mute: true }] },
			],
			[
				"audio_inputs: the mixer adds a track",
				{ asrc: "Primary" },
				() =>
					call(
						setAudioMixProcedure,
						{ id: "Primary", track: { number: 2, on: true } },
						{ context: makeRpcContext() },
					),
				{ audio_inputs: [{ ...MIX, tracks: [1, 2] }] },
			],
			[
				"audio_inputs: the whole mix saved",
				{ asrc: "Primary" },
				setConfig({ audio_inputs: [{ ...MIX, gain_db: -6 }] }),
				{ audio_inputs: [{ ...MIX, gain_db: -6 }] },
			],
			[
				"video_codec: Encoder Manual",
				{},
				setConfig({ video_codec: "h265" }),
				{ video_codec: "h265" },
			],
			[
				"selected_video_input, source_stable_id: a switch to a camera",
				{},
				setConfig({ source: "osmo" }),
				{
					source: "osmo",
					selected_video_input: "osmo",
					source_stable_id: OSMO_STABLE,
				},
			],
			[
				"composition: picture-in-picture on",
				{},
				setConfig({ composition: PIP }),
				{ composition: PIP },
			],
			[
				"input_mode: the camera's other format",
				{
					source: "osmo",
					pipeline: "libuvch264",
					selected_video_input: "osmo",
				},
				setConfig({ input_mode: "mjpeg" }),
				{ input_mode: "mjpeg" },
			],
			[
				"resolution, framerate: an override",
				{ pipeline: "hdmi" },
				setConfig({ resolution: "1080p", framerate: 30 }),
				{ resolution: "1080p", framerate: 30 },
			],
			[
				"srtla_addr, srtla_port: a manual destination",
				{},
				setConfig({ srtla_addr: "127.0.0.1", srtla_port: 5000 }),
				{ srtla_addr: "127.0.0.1", srtla_port: 5000 },
			],
			[
				"relay_server: a relay destination",
				{},
				setConfig({ relay_server: "r1" }),
				{ relay_server: "r1" },
			],
			[
				"relay_account: a relay account",
				{},
				setConfig({ relay_account: "a" }),
				{ relay_account: "a" },
			],
			[
				"srt_streamid, relay_streamid_override: stream ids",
				{},
				setConfig({ srt_streamid: "s", relay_streamid_override: "o" }),
				{ srt_streamid: "s", relay_streamid_override: "o" },
			],
			[
				"selected_ingest_endpoint: a managed slot",
				{},
				setConfig({ selected_ingest_endpoint: "ep-1" }),
				{ selected_ingest_endpoint: "ep-1" },
			],
			[
				"srtla_addr, srtla_port, srt_streamid: a start on a manual destination",
				{
					...START,
					srtla_addr: undefined,
					srtla_port: undefined,
					srt_streamid: undefined,
				},
				() =>
					updateConfig({
						srtla_addr: "127.0.0.1",
						srtla_port: 5000,
						srt_streamid: "s",
					}),
				{ srtla_addr: "127.0.0.1", srtla_port: 5000, srt_streamid: "s" },
			],
			[
				"resolution, framerate, audio_inputs: a start that carries them",
				START,
				() =>
					updateConfig({
						resolution: "1080p",
						framerate: 30,
						audio_inputs: [{ ...MIX, mute: true }],
					}),
				{
					resolution: "1080p",
					framerate: 30,
					audio_inputs: [{ ...MIX, mute: true }],
				},
			],
			[
				"selected_video_input: a live switch to a camera",
				{ asrc: "Primary" },
				() =>
					applySwitchInputFollow("osmo", {
						success: true,
						active_input: "osmo",
						gap_ms: 1,
					}),
				{ source: "osmo", selected_video_input: "osmo" },
			],
			[
				"resolution, framerate: a saved mode the camera does not offer, clamped",
				{
					source: "osmo",
					pipeline: "libuvch264",
					selected_video_input: "osmo",
					input_mode: "uvc_h264",
					resolution: "2160p",
					framerate: 30,
				},
				() => broadcastSources(),
				{ resolution: "1080p", framerate: 30 },
			],
		];
	for (const [name, config, write, expected] of sets)
		test(`set, ${name}`, async () => {
			Object.assign(getConfig(), config);

			expect(await heardFrom(write)).toEqual(["config"]);
			expect(told()).toEqual(stored());
			expect(told()).toMatchObject(expected);
		});

	// Heard twice: the write that stages it, and the commit once it is applied.
	for (const [name, config, input, heard] of [
		[
			"sets resolution",
			{ resolution: "1080p", framerate: 30 },
			{ resolution: "2160p" },
			["config", "config"],
		],
		[
			"clears the composition",
			{ composition: PIP },
			{ composition: null },
			["config", ...cleared("composition")],
		],
	] as const)
		test(`an apply-now change the engine applied ${name}`, async () => {
			setApplyNowGateForTest({
				isStreamLive: () => true,
				dispatch: async () => ({ result: "applied", attemptId: "a1" }),
			});
			try {
				Object.assign(getConfig(), { pipeline: "hdmi", ...config });

				expect(
					await heardFrom(
						setConfig({ ...input, apply_now: true } as StreamingSetConfigInput),
					),
				).toEqual([...heard]);
				expect(told()).toEqual(stored());
			} finally {
				setApplyNowGateForTest(null);
				clearStagedConfigChange();
			}
		});

	test("selected_video_input, source_stable_id: a start on a network source", async () => {
		Object.assign(getConfig(), {
			...START,
			source: "osmo",
			pipeline: "libuvch264",
			selected_video_input: "osmo",
			source_stable_id: OSMO_STABLE,
		});

		expect(
			await heardFrom(() =>
				// What `streaming.start` hands over: the routed source and its input.
				updateConfig({
					source: "rtmp",
					pipeline: "rtmp",
					selected_video_input: undefined,
				}),
			),
		).toEqual(cleared("selected_video_input", "source_stable_id"));
		expect(told()).toEqual(stored());
	});

	test("selected_video_input: a start that names no source keeps the saved one", async () => {
		Object.assign(getConfig(), {
			...START,
			source: "osmo",
			pipeline: "libuvch264",
			selected_video_input: "osmo",
			source_stable_id: OSMO_STABLE,
		});

		expect(await heardFrom(() => updateConfig({}))).toEqual(["config"]);
		expect(told()).toMatchObject({
			source: "osmo",
			selected_video_input: "osmo",
		});
	});

	test("srtla_addr, srtla_port, srt_streamid: a start on a relay", async () => {
		const cwd = process.cwd();
		// `relays_cache.json` is written to the working directory.
		process.chdir(tab.directory);
		try {
			await updateCachedRelays({
				servers: {
					r1: { type: "srtla", name: "R", addr: "127.0.0.1", port: 5000 },
				},
				accounts: { a1: { name: "A", ingest_key: "key1" } },
			});
			Object.assign(getConfig(), {
				pipeline: "hdmi",
				max_br: 5000,
				srt_latency: 2000,
				bitrate_overlay: false,
				delay: 0,
				asrc: "Primary",
				srtla_addr: "127.0.0.1",
				srtla_port: 5000,
				srt_streamid: "s",
			});

			expect(
				await heardFrom(() =>
					updateConfig({ relay_server: "r1", relay_account: "a1" }),
				),
			).toEqual(cleared("srtla_addr", "srtla_port", "srt_streamid"));
			await updateCachedRelays(undefined);
		} finally {
			process.chdir(cwd);
		}
	});

	test("composition: residue an engine no longer offers, dropped by any save", async () => {
		await engine([]);
		try {
			Object.assign(getConfig(), { composition: PIP });

			expect(await heardFrom(setConfig({ max_br: 6000 }))).toEqual(
				cleared("composition"),
			);
		} finally {
			await engine(["composition", "composition-geometry"]);
		}
	});

	test("set, sources_visibility: the test pattern hidden", async () => {
		expect(
			await heardFrom(() =>
				call(
					setSourceVisibilityProcedure,
					{ hide_test_pattern: true },
					{ context: makeRpcContext() },
				),
			),
		).toEqual(["config"]);
		expect(told()).toMatchObject({
			sources_visibility: { hide_test_pattern: true },
		});
	});

	test("set, max_br: a live bitrate change", async () => {
		Object.assign(getConfig(), { max_br: 5000 });
		updateStatus(true);
		try {
			expect(
				await heardFrom(() =>
					call(
						setBitrateProcedure,
						{ max_br: 7000 },
						{ context: makeRpcContext() },
					),
				),
			).toEqual(["config"]);
			expect(told()).toEqual(stored());
			expect(told()).toMatchObject({ max_br: 7000 });
		} finally {
			updateStatus(false);
		}
	});

	test("set, source, selected_video_input: the camera came back under another node", async () => {
		Object.assign(getConfig(), {
			source: "osmo-old",
			selected_video_input: "osmo-old",
			source_stable_id: OSMO_STABLE,
		});

		expect(
			await heardFrom(() => {
				applyObservedEngineDevices([osmo("osmo")]);
				broadcastSources();
			}),
		).toEqual(["config"]);
		expect(told()).toMatchObject({
			source: "osmo",
			selected_video_input: "osmo",
		});
	});

	test("set, asrc: the microphone came back under another card", async () => {
		Object.assign(getConfig(), { asrc: "Old" });

		expect(
			await heardFrom(() =>
				reconcileConfiguredAudioIdentity(
					new Map([["Primary", { stable_id: "usb:mic" }]]) as Parameters<
						typeof reconcileConfiguredAudioIdentity
					>[0],
					{ Primary: "hw:CARD=primary" },
					new Map([["Old", "usb:mic"]]),
				),
			),
		).toEqual(["config"]);
		expect(told()).toMatchObject({ asrc: "Primary" });
	});

	test("selected_video_input: the engine no longer lists the selected camera", async () => {
		Object.assign(getConfig(), { selected_video_input: "gone" });

		await heardFrom(async () => {
			let reachable = false;
			const registry = createDeviceRegistry({
				getEngineDevices: async () => (reachable ? [] : null),
				listVideoCards: async () => [],
			});
			await registry.scan();
			reachable = true;
			await registry.scan();
		});

		expect([...named()]).toEqual(["selected_video_input"]);
	});
});

describe("through the device's other writers", () => {
	test("autostart: set and reset are values, heard at the write", async () => {
		expect(await heardFrom(() => setAutostart(true))).toEqual(["config"]);
		expect(await heardFrom(() => setAutostart(false))).toEqual(["config"]);
		expect(frames().at(-1)?.config).toMatchObject({ autostart: false });
	});

	test("set, stream_profile and its srt_latency, fec_enabled, recovery_mode: a profile from the cloud", async () => {
		wireSetProfile();
		try {
			expect(
				await heardFrom(() =>
					handleSetProfile({
						commandId: "11111111-1111-4111-8111-111111111111",
						config: {
							presetId: "balanced",
							latencyMs: 2000,
							fecEnabled: false,
							recoveryMode: "standard",
						},
					}),
				),
			).toEqual(["config"]);
			expect(told()).toMatchObject({
				stream_profile: "balanced",
				srt_latency: 2000,
				fec_enabled: false,
				recovery_mode: "standard",
			});
		} finally {
			resetSetProfile();
		}
	});

	test("country: a regulatory choice made", async () => {
		expect(await heardFrom(() => persistWifiCountry("BO"))).toEqual(["config"]);
		expect(told()).toMatchObject({ country: "BO" });
	});

	test("country: the regulatory choice removed", async () => {
		Object.assign(getConfig(), { country: "BO" });

		expect(await heardFrom(() => persistWifiCountry(undefined))).toEqual(
			cleared("country"),
		);
	});

	test("remote_key, device_id: a forced re-pair", async () => {
		Object.assign(getConfig(), { remote_key: "k", device_id: "d" });

		expect(
			await heardFrom(() =>
				forceRepairMigration("tokenless-on-paseto-activation"),
			),
		).toEqual(cleared("remote_key", "device_id"));
	});

	test("remote_key, device_id, custom_provider: a new remote key set, before the reconnect it waits for", async () => {
		const custom_provider = { name: "Mine", host: "relay.example" };
		let reconnected: Promise<void> | undefined;

		expect(
			await heardFrom(() => {
				reconnected = setRemoteConfig({
					remote_key: "",
					device_id: "d",
					provider: "custom",
					custom_provider,
				} as Parameters<typeof setRemoteConfig>[0]);
			}),
		).toEqual(["config"]);
		expect(told()).toMatchObject({
			remote_key: "",
			device_id: "d",
			custom_provider,
		});
		await reconnected;
	});

	test("relay_server, relay_account, custom_provider: a new remote key, before the reconnect it waits for", async () => {
		Object.assign(getConfig(), {
			remote_key: "old",
			relay_server: "r1",
			relay_account: "a1",
			custom_provider: { name: "Mine", host: "relay.example" },
		});
		let reconnected: Promise<void> | undefined;

		// The call is not awaited: what is heard here precedes its reconnect.
		expect(
			await heardFrom(() => {
				reconnected = setRemoteConfig({ remote_key: "" });
			}),
		).toEqual(cleared("relay_server", "relay_account", "custom_provider"));
		await reconnected;
		expect(frames()).toHaveLength(2);
	});

	for (const [name, config, accounts, heard] of [
		[
			"relay_server, relay_account, relay_streamid_override: the subscription's relay preselected",
			{},
			{ a1: { name: "A", ingest_key: "key1" } },
			["config"],
		],
		[
			"relay_account, relay_streamid_override: another provider's relay replaced, with no account to use",
			{
				relay_server: namespacedRelayId("custom", "s9"),
				relay_account: "a9",
				relay_streamid_override: "key9",
			},
			{},
			cleared("relay_account", "relay_streamid_override"),
		],
	] as const)
		test(name, async () => {
			const cwd = process.cwd();
			// `relays_cache.json` is written to the working directory.
			process.chdir(tab.directory);
			try {
				Object.assign(getConfig(), { remote_key: "k", ...config });

				expect(
					await heardFrom(() =>
						handleRemoteRelays({
							servers: {
								s1: { type: "srtla", name: "S", addr: "192.0.2.1", port: 5000 },
							},
							accounts,
						} as Parameters<typeof handleRemoteRelays>[0]),
					),
				).toEqual([...heard]);
				expect(told()).toEqual(stored());
				expect(told()).toHaveProperty("relay_server");
				await updateCachedRelays(undefined);
			} finally {
				process.chdir(cwd);
			}
		});

	test("srtla_addr, srtla_port, srt_streamid: a manual destination matched to a relay", async () => {
		const cwd = process.cwd();
		// `relays_cache.json` is written to the working directory.
		process.chdir(tab.directory);
		try {
			Object.assign(getConfig(), {
				srtla_addr: "192.0.2.1",
				srtla_port: 5000,
				srt_streamid: "key1",
			});

			expect(
				await heardFrom(() =>
					handleRemoteRelays({
						servers: {
							s1: { type: "srtla", name: "S", addr: "192.0.2.1", port: 5000 },
						},
						accounts: { a1: { name: "A", ingest_key: "key1" } },
					} as Parameters<typeof handleRemoteRelays>[0]),
				),
			).toEqual(cleared("srtla_addr", "srtla_port", "srt_streamid"));
			await updateCachedRelays(undefined);
		} finally {
			process.chdir(cwd);
		}
	});

	test("selected_ingest_endpoint: a managed slot selected", async () => {
		handleIngestSlots({
			slots: [
				{
					endpointId: "ep-2",
					host: "relay.example",
					port: 5000,
					protocol: "srtla",
					streamId: "s",
					obsInstanceId: null,
				},
			],
		});
		try {
			expect(
				await heardFrom(() => expect(selectIngestSlot("ep-2")).toBe(true)),
			).toEqual(["config"]);
			expect(frames().at(-1)?.config).toMatchObject({
				selected_ingest_endpoint: "ep-2",
			});
		} finally {
			resetIngestSlots();
		}
	});

	test("bond_opt_out: the last opt-out removed from a tab that was told of it", async () => {
		resetBondFixture();
		installHuaweiIdentityResolver();
		attachHuaweiTwins();
		try {
			setPersistentBondOptOut("eth1", true);
			expect(getConfig().bond_opt_out).toBeDefined();

			expect(
				await heardFrom(() => setPersistentBondOptOut("eth1", false)),
			).toEqual(cleared("bond_opt_out"));
		} finally {
			resetBondFixture();
		}
	});

	for (const [name, action, keys] of [
		["on", kioskStart, ["kiosk_enabled", "kiosk_last_state"]],
		// Off is already its state, so only the choice itself was ever saved.
		["off", kioskStop, ["kiosk_enabled"]],
	] as const)
		test(`${keys.join(", ")}: a first kiosk choice, ${name}, refused by the device`, async () => {
			const refuse = async () => {
				// The choice is saved before the add-on answers; a tab is told of it.
				broadcastConfig(getConfig());
				return { success: false, error: "streaming", phase: "failed" };
			};

			const heard = await heardFrom(() =>
				expect(
					action({
						systemctl: async () => ({ stdout: "", stderr: "" }),
						isFailed: async () => false,
						isActive: async () => false,
						getNRestarts: async () => 0,
						noDisplayMarkerExists: async () => false,
						removeNoDisplayMarker: async () => {},
						oskSignal: async () => {},
						broadcast: () => {},
						loadCogDescriptor: () => ({ id: "cog-display" }) as AddonDescriptor,
						enableAddon: refuse,
						disableAddon: refuse,
					} as unknown as Parameters<typeof kioskStart>[0]),
				).rejects.toThrow("streaming"),
			);
			stopKioskPolling();

			expect(heard.slice(1)).toEqual(cleared(...keys));
		});

	test("any setting: a clear whose save fails is still what the device runs", async () => {
		Object.assign(getConfig(), { video_codec: "h264" });
		// A directory in place of the file: the atomic rename cannot land.
		const path = join(tab.directory, "blocked");
		await mkdir(join(path, "x"), { recursive: true });

		expect(
			await heardFrom(() => {
				setConfigFilePath(path);
				getConfig().video_codec = undefined;
				expect(() => saveConfig()).toThrow();
			}),
		).toEqual(cleared("video_codec"));
	});

	function startSession() {
		const session = createStreamSessionOrchestrator({
			createAttemptId: () => "attempt-1",
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			retryPolicy: {
				maxAttempts: 1,
				totalBudgetMs: 60_000,
				baseDelayMs: 1,
				maxDelayMs: 1,
			},
			// The production hook (stream-session-production.ts).
			onStreamCommitted: () => void noteStreamedSourceCommitted(),
		});
		return heardFrom(async () => {
			const { result } = await session.start({
				origin: "ui",
				launch: async () => {},
			});
			expect(result).toBe("started");
		});
	}

	test("last_streamed_source_stable_id: a successful start on a camera sets it", async () => {
		applyObservedEngineDevices([osmo("osmo")]);
		try {
			Object.assign(getConfig(), { source: "osmo" });

			expect(await startSession()).toEqual(["config"]);
			expect(frames().at(-1)?.config).toMatchObject({
				last_streamed_source: "osmo",
				last_streamed_source_stable_id: OSMO_STABLE,
			});
		} finally {
			resetEngineDeviceCache();
		}
	});

	test("last_streamed_source_stable_id: a successful start on a source with no hardware identity clears it", async () => {
		Object.assign(getConfig(), {
			source: "rtmp",
			last_streamed_source: "video3",
			last_streamed_source_stable_id: "usb:2ca3:0023:SN-A",
		});

		expect(await startSession()).toEqual(
			cleared("last_streamed_source_stable_id"),
		);
	});

	for (const [name, candidate, heard] of [
		["changed the resolution", {}, ["config"]],
		[
			"turned the composition off",
			{ composition: null },
			cleared("composition"),
		],
	] as const)
		test(`a crash-recovered apply-now change that ${name}`, async () => {
			const composition = {
				secondary_input_id: "video1",
				layout: "pip-top-left",
				alpha: 1,
			} as const;
			Object.assign(getConfig(), { resolution: "1080p", composition });
			const marker = JSON.stringify({
				attemptId: "a1",
				startedAt: 1,
				candidate: { resolution: "2160p", ...candidate },
				previous: {
					resolution: "1080p",
					...("composition" in candidate ? { composition } : {}),
				},
			});

			expect(
				await heardFrom(() =>
					expect(
						reconcileInflightConfigChange(
							{
								streaming: true,
								switching: true,
								resolution: "2160p",
								pipelinePlaying: true,
								framesEmitted: 500,
							},
							{
								markerPath: "config.inflight.json",
								readMarker: () => marker,
								writeMarker: () => {},
								removeMarker: () => {},
							},
						),
					).toBe("persisted_candidate"),
				),
			).toEqual([...heard]);
			expect(told()).toEqual(stored());
		});

	for (const [name, payload, heard] of [
		["a value", { max_br: 6000 }, ["config"]],
		[
			"a setting that was absent",
			{ video_codec: "h264" },
			cleared("video_codec"),
		],
	] as const)
		test(`a self-fencing change of ${name}, and the watchdog that reverts it unconfirmed`, async () => {
			Object.assign(getConfig(), { max_br: 5000 });
			const reverted = Promise.withResolvers<void>();
			let watchdog = () => {};
			let results = 0;
			try {
				expect(
					await heardFrom(() =>
						handleSelfFencingOp(
							{
								v: PROTOCOL_VERSION,
								kind: "command",
								type: "network.reconfig",
								cid: "01J00000000000000000000000",
								role: "owner",
								self_fencing: true,
								payload,
							},
							{
								sendResult: () => {
									results += 1;
									if (results === 2) reverted.resolve();
									return true;
								},
								isSubsystemReady: async () => true,
								acquireMutationLease: async () => ({ ok: true }),
								admitDisruptiveAction: async () => ({ ok: true }),
								setTimer: (fn) => {
									watchdog = fn;
									return 0 as unknown as ReturnType<typeof setTimeout>;
								},
								clearTimer: () => {},
							},
						),
					),
				).toEqual(["config"]);
				expect(told()).toMatchObject(payload);

				expect(
					await heardFrom(async () => {
						watchdog();
						await reverted.promise;
					}),
				).toEqual([...heard]);
				expect(told()).toEqual({ max_br: 5000 });
			} finally {
				resetSelfFencingState();
			}
		});

	test("a legacy plaintext password replaced by a new one", async () => {
		// A child process: setPassword rewrites auth_tokens.json in its working tab.directory.
		const script = `
			const root = ${JSON.stringify(join(import.meta.dir, ".."))};
			const { getConfig } = await import(root + "/modules/config.ts");
			const { broadcastConfig } = await import(root + "/rpc/config-broadcast.ts");
			const { createContext } = await import(root + "/rpc/context.ts");
			const { addClient } = await import(root + "/rpc/events.ts");
			const { setPasswordProcedure } = await import(root + "/rpc/procedures/auth.procedure.ts");
			const { call } = await import(Bun.resolveSync("@orpc/server", root));
			let sent = [];
			const ws = { data: { isAuthenticated: true, lastActive: 0 }, send: (m) => { sent.push(m); }, close() {} };
			addClient(ws);
			getConfig().password = "legacy";
			broadcastConfig(getConfig());
			sent = [];
			await call(setPasswordProcedure, { password: "a-new-password" }, { context: createContext(ws) });
			const heard = sent.map((m) => JSON.parse(m)).filter((f) => "config" in f || "config_clear" in f)
				.map((f) => ("config" in f ? "config" : f.config_clear));
			await Bun.write("heard.json", JSON.stringify(heard));
			process.exit(0);
		`;
		await Bun.write(join(tab.directory, "run.ts"), script);
		await Bun.write(
			join(tab.directory, "setup.json"),
			Bun.file(join(import.meta.dir, "../../setup.json")),
		);
		const child = Bun.spawn(
			[process.execPath, "run", join(tab.directory, "run.ts")],
			{
				cwd: tab.directory,
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(0);

		expect(await Bun.file(join(tab.directory, "heard.json")).json()).toEqual([
			"config",
			{ keys: ["password"] },
		]);
	});
});
