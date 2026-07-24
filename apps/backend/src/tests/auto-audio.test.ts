import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type CerastreamClient,
	type ListDevicesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO, type StreamSource } from "@ceraui/rpc/schemas";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import {
	deriveAudioSources,
	getAudioDevices,
	setMockAudioDevicesProvider,
	updateAudioDevices,
} from "../modules/streaming/audio.ts";
import {
	type EngineAudioDevice,
	resolveAudioLabels,
} from "../modules/streaming/audio-naming.ts";
import {
	type AutoAsrcResolution,
	buildAutoLaunchConfig,
	getPendingAudioFollowAsrc,
	getResolvedAsrc,
	getResolvedAsrcReason,
	launchAsrcFor,
	refreshResolvedAsrcPreview,
	resetAutoAudioState,
	resolveAutoAsrc,
	resolveAutoAsrcFromLiveState,
	setAutoAudioBroadcaster,
	setPendingAudioFollowAsrc,
	setResolvedAsrcFromStart,
} from "../modules/streaming/auto-audio.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import {
	getPipelineList,
	initPipelines,
	type Pipeline,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import {
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import {
	updateStatus,
	validateConfig,
} from "../modules/streaming/streaming.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";
import { maybeProbeAudioSource } from "../modules/streaming/streamloop/start-stream.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function captureSource(
	kind: string,
	displayName: string,
	id = displayName,
): StreamSource {
	return {
		id,
		pipelineId: "pipe",
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable",
		available: true,
		origin: "capture",
		kind: kind as StreamSource extends { kind: infer K } ? K : never,
		displayName,
		devicePath: "/dev/video0",
	} as StreamSource;
}

function networkSource(): StreamSource {
	return {
		id: "rtmp",
		pipelineId: "rtmp",
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "embedded",
		available: true,
		origin: "network",
		labelKey: "settings.sources.rtmp",
		requiresGateway: "rtmp",
		url: null,
	};
}

function virtualSource(): StreamSource {
	return {
		id: "test",
		pipelineId: "test",
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: true,
		origin: "virtual",
		labelKey: "settings.sources.test",
	};
}

function engineAudio(
	displayName: string,
	alsaCardId?: string,
	inputId = displayName,
): EngineAudioDevice {
	return {
		input_id: inputId,
		display_name: displayName,
		...(alsaCardId !== undefined ? { alsa_card_id: alsaCardId } : {}),
	};
}

/** The rk3588 audio map produced by audio.ts on the test host (setup.hw). */
const HDMI_MAP: Record<string, string> = {
	HDMI: "rockchiphdmiin",
	"No audio": "No audio",
	"Pipeline default": "Pipeline default",
};
const USB_MAP: Record<string, string> = {
	"USB audio": "usbaudio",
	"No audio": "No audio",
	"Pipeline default": "Pipeline default",
};
const CAMLINK_MAP: Record<string, string> = {
	"Cam Link 4K": "C4K",
	"No audio": "No audio",
	"Pipeline default": "Pipeline default",
};

// ─── resolveAutoAsrc — the six deterministic rules ───────────────────────────

describe("resolveAutoAsrc — deterministic rules", () => {
	test("Rule 1: network source + embedded cap → embedded (null/null)", () => {
		expect(
			resolveAutoAsrc({
				source: networkSource(),
				audioDevices: {},
				engineAudio: [],
				networkEmbeddedAudio: true,
			}),
		).toEqual({ asrcKey: null, cardId: null, reason: "embedded" });
	});

	test("Rule 2: network source WITHOUT the embedded cap → pipeline default", () => {
		expect(
			resolveAutoAsrc({
				source: networkSource(),
				audioDevices: USB_MAP,
				engineAudio: [],
				networkEmbeddedAudio: false,
			}),
		).toEqual({
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
	});

	test("Rule 2: the virtual (test-pattern) source → pipeline default", () => {
		expect(
			resolveAutoAsrc({
				source: virtualSource(),
				audioDevices: HDMI_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
	});

	test("Rule 3: HDMI capture + rockchiphdmiin present → HDMI card", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI capture"),
				audioDevices: HDMI_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({ asrcKey: "HDMI", cardId: "rockchiphdmiin", reason: "hdmi" });
	});

	test("Rule 3 miss: HDMI capture but no rockchiphdmiin card → pipeline default", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI capture"),
				audioDevices: {
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
	});

	test("Rule 4: Cam Link capture + C4K present → Cam Link 4K card", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("camlink", "Cam Link 4K"),
				audioDevices: CAMLINK_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "Cam Link 4K",
			cardId: "C4K",
			reason: "camlink",
		});
	});

	test("Rule 5i: USB capture + same-device engine audio join → that card", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("uvc_h264", "RØDE Streamer X"),
				audioDevices: {
					"RØDE Streamer Audio": "rodecard",
					"USB audio": "usbaudio",
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [engineAudio("RØDE Streamer Mic", "rodecard")],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "RØDE Streamer Audio",
			cardId: "rodecard",
			reason: "usb-same-device",
		});
	});

	test("Rule 5i degradation: engine audio WITHOUT alsa_card_id → usb-alias tier", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("uvc_h264", "RØDE Streamer X"),
				audioDevices: USB_MAP,
				// Current cerastream pin strips alsa_card_id → the join key is absent.
				engineAudio: [engineAudio("RØDE Streamer Mic", undefined)],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "USB audio",
			cardId: "usbaudio",
			reason: "usb-alias",
		});
	});

	test("Rule 5i miss (short prefix) falls to usb-alias, not same-device", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("mjpeg", "Logitech Cam"),
				audioDevices: {
					"Some Mic": "somecard",
					"USB audio": "usbaudio",
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [engineAudio("Blue Yeti", "somecard")],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "USB audio",
			cardId: "usbaudio",
			reason: "usb-alias",
		});
	});

	test("Rule 5ii: USB capture + usbaudio present → USB audio card", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("usb", "Generic USB Cam"),
				audioDevices: USB_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "USB audio",
			cardId: "usbaudio",
			reason: "usb-alias",
		});
	});

	test("Rule 5iii: USB capture, no usbaudio, a device card present → first-device", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("usb", "Generic USB Cam"),
				audioDevices: {
					HDMI: "rockchiphdmiin",
					"Analog in": "rockchipes8388",
					"Some Card": "somecard",
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "Some Card",
			cardId: "somecard",
			reason: "first-device",
		});
	});

	test("Rule 6 (QA failure): USB capture + ZERO audio cards → pipeline default", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("usb", "Generic USB Cam"),
				audioDevices: {
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
	});

	test("Rule 6: undefined source → pipeline default", () => {
		expect(
			resolveAutoAsrc({
				source: undefined,
				audioDevices: USB_MAP,
				engineAudio: [],
				networkEmbeddedAudio: true,
			}),
		).toEqual({
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
	});
});

// ─── Source×audio mixture matrix M1–M6 (Task 21) ─────────────────────────────

const DUAL_USB_MAP: Record<string, string> = {
	"RØDE Streamer Mic": "rode_card",
	"Elgato Wave:3": "elgato_wave3",
	"No audio": "No audio",
	"Pipeline default": "Pipeline default",
};

describe("source×audio mixture matrix (M1–M6)", () => {
	test("M1: network source + network_embedded_audio → embedded (no ALSA target)", () => {
		expect(
			resolveAutoAsrc({
				source: networkSource(),
				audioDevices: USB_MAP,
				engineAudio: [],
				networkEmbeddedAudio: true,
			}),
		).toEqual({ asrcKey: null, cardId: null, reason: "embedded" });
	});

	test("M2: network source WITHOUT the embedded cap → pipeline default (legacy ALSA path)", () => {
		expect(
			resolveAutoAsrc({
				source: networkSource(),
				audioDevices: USB_MAP,
				engineAudio: [],
				networkEmbeddedAudio: false,
			}),
		).toEqual({
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
	});

	test("M3: USB cam + second USB mic → Auto resolves to the cam's OWN audio (same-device prefix join); both offered with distinct real labels", () => {
		const engine = [
			engineAudio("RØDE Streamer Mic", "rode_card"),
			engineAudio("Elgato Wave:3", "elgato_wave3"),
		];
		expect(
			resolveAutoAsrc({
				source: captureSource("uvc_h264", "RØDE Streamer X"),
				audioDevices: DUAL_USB_MAP,
				engineAudio: engine,
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "RØDE Streamer Mic",
			cardId: "rode_card",
			reason: "usb-same-device",
		});

		const labels = resolveAudioLabels(DUAL_USB_MAP, engine, new Map());
		expect(labels.get("RØDE Streamer Mic")).toBe("RØDE Streamer Mic");
		expect(labels.get("Elgato Wave:3")).toBe("Elgato Wave:3");
		expect(labels.get("RØDE Streamer Mic")).not.toBe(
			labels.get("Elgato Wave:3"),
		);
	});

	test("M4: HDMI video → Auto resolves to the HDMI card (rule 3)", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI capture"),
				audioDevices: HDMI_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({ asrcKey: "HDMI", cardId: "rockchiphdmiin", reason: "hdmi" });
	});

	test("M5: the resolved audio card disappears → Auto falls through to the next rule; the input map is NOT mutated", () => {
		const afterUnplug: Record<string, string> = {
			"Some Card": "somecard",
			"No audio": "No audio",
			"Pipeline default": "Pipeline default",
		};
		const snapshot = structuredClone(afterUnplug);
		const r = resolveAutoAsrc({
			source: captureSource("usb", "Generic USB Cam"),
			audioDevices: afterUnplug,
			engineAudio: [],
			networkEmbeddedAudio: undefined,
		});
		expect(r).toEqual({
			asrcKey: "Some Card",
			cardId: "somecard",
			reason: "first-device",
		});
		expect(afterUnplug).toEqual(snapshot);
	});

	test("M6: test-pattern / virtual source → pipeline default", () => {
		expect(
			resolveAutoAsrc({
				source: virtualSource(),
				audioDevices: HDMI_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
	});
});

// ─── Dual-space invariants (Oracle R1-3) ─────────────────────────────────────

describe("resolveAutoAsrc — dual-space invariants (asrcKey ≠ cardId)", () => {
	test("HDMI → { asrcKey: 'HDMI', cardId: 'rockchiphdmiin' }", () => {
		const r = resolveAutoAsrc({
			source: captureSource("hdmi", "HDMI capture"),
			audioDevices: HDMI_MAP,
			engineAudio: [],
			networkEmbeddedAudio: undefined,
		});
		expect(r.asrcKey).toBe("HDMI");
		expect(r.cardId).toBe("rockchiphdmiin");
		expect(r.asrcKey).not.toBe(r.cardId);
	});

	test("USB → { asrcKey: 'USB audio', cardId: 'usbaudio' }", () => {
		const r = resolveAutoAsrc({
			source: captureSource("usb", "Generic USB Cam"),
			audioDevices: USB_MAP,
			engineAudio: [],
			networkEmbeddedAudio: undefined,
		});
		expect(r.asrcKey).toBe("USB audio");
		expect(r.cardId).toBe("usbaudio");
		expect(r.asrcKey).not.toBe(r.cardId);
	});
});

// ─── launchAsrcFor + buildAutoLaunchConfig (launch pseudo-source rule) ────────

describe("launchAsrcFor — the launch pseudo-source rule", () => {
	test("embedded → undefined (probe skipped, audio.device omitted)", () => {
		expect(
			launchAsrcFor({ asrcKey: null, cardId: null, reason: "embedded" }),
		).toBeUndefined();
	});

	test("pipeline-default → undefined", () => {
		expect(
			launchAsrcFor({
				asrcKey: "Pipeline default",
				cardId: null,
				reason: "pipeline-default",
			}),
		).toBeUndefined();
	});

	test("a real card → its asrcKey", () => {
		expect(
			launchAsrcFor({
				asrcKey: "HDMI",
				cardId: "rockchiphdmiin",
				reason: "hdmi",
			}),
		).toBe("HDMI");
	});
});

describe("buildAutoLaunchConfig — launch copy never mutates the persisted config", () => {
	const RESOLVED: AutoAsrcResolution = {
		asrcKey: "HDMI",
		cardId: "rockchiphdmiin",
		reason: "hdmi",
	};

	test("carries the resolved key WITHOUT mutating the input (frozen config)", () => {
		const config = Object.freeze({
			asrc: AUDIO_SOURCE_AUTO,
			pipeline: "hdmi",
			max_br: 5000,
		}) as RuntimeConfig;
		const launch = buildAutoLaunchConfig(config, RESOLVED);
		expect(launch.asrc).toBe("HDMI");
		expect(launch).not.toBe(config);
		// The persisted config keeps the "Auto" sentinel byte-for-byte.
		expect(config.asrc).toBe(AUDIO_SOURCE_AUTO);
	});

	test("a pseudo resolution OMITS asrc entirely (never { asrc: undefined })", () => {
		const config = Object.freeze({
			asrc: AUDIO_SOURCE_AUTO,
			pipeline: "test",
		}) as RuntimeConfig;
		const launch = buildAutoLaunchConfig(config, {
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
		expect("asrc" in launch).toBe(false);
		expect(config.asrc).toBe(AUDIO_SOURCE_AUTO);
	});
});

// ─── Module-state emitters ───────────────────────────────────────────────────

describe("emitters — two-function API + pending slot", () => {
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

	test("setResolvedAsrcFromStart updates current, clears pending, broadcasts all three", () => {
		setPendingAudioFollowAsrc("USB audio");
		broadcasts = [];
		setResolvedAsrcFromStart("HDMI", "hdmi");
		expect(getResolvedAsrc()).toBe("HDMI");
		expect(getResolvedAsrcReason()).toBe("hdmi");
		expect(getPendingAudioFollowAsrc()).toBeNull();
		expect(broadcasts).toEqual([
			{
				resolved_asrc: "HDMI",
				resolved_asrc_reason: "hdmi",
				pending_audio_follow_asrc: null,
			},
		]);
	});

	test("setPendingAudioFollowAsrc broadcasts ONLY the pending field", () => {
		setPendingAudioFollowAsrc("USB audio");
		expect(getPendingAudioFollowAsrc()).toBe("USB audio");
		expect(broadcasts).toEqual([{ pending_audio_follow_asrc: "USB audio" }]);
	});

	test("Lifecycle (a): setResolvedAsrcFromStart publishes even AFTER is_streaming flipped true", () => {
		// The real start path calls updateStatus(true) BEFORE startStream runs.
		updateStatus(true);
		broadcasts = [];
		setResolvedAsrcFromStart("HDMI", "hdmi");
		expect(getResolvedAsrc()).toBe("HDMI");
		expect(broadcasts).toEqual([
			{
				resolved_asrc: "HDMI",
				resolved_asrc_reason: "hdmi",
				pending_audio_follow_asrc: null,
			},
		]);
	});

	test("refreshResolvedAsrcPreview is a NO-OP while streaming (frozen live value)", () => {
		setResolvedAsrcFromStart("HDMI", "hdmi");
		updateStatus(true);
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		broadcasts = [];
		refreshResolvedAsrcPreview();
		expect(getResolvedAsrc()).toBe("HDMI");
		expect(getResolvedAsrcReason()).toBe("hdmi");
		expect(broadcasts).toEqual([]);
		delete getConfig().asrc;
	});

	test("refreshResolvedAsrcPreview is a NO-OP when config.asrc is not the sentinel", () => {
		getConfig().asrc = "USB audio";
		broadcasts = [];
		refreshResolvedAsrcPreview();
		expect(broadcasts).toEqual([]);
		delete getConfig().asrc;
	});
});

// ─── validateConfig — accepts the sentinel, rejects a genuine unknown ─────────

describe("validateConfig — 'Auto' sentinel acceptance (Oracle R2-1)", () => {
	let audioPipelineId: string;

	beforeAll(async () => {
		setMockHardware("rk3588");
		await initPipelines({
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
		const found = Object.entries(getPipelineList()).find(
			([, p]) => p.supportsAudio,
		);
		audioPipelineId = found?.[0] ?? "";
	});
	afterAll(async () => {
		clearCapabilitiesCache();
		resetEngineDeviceCache();
		setMockHardware("rk3588");
		await initPipelines({
			fetchEngineCapabilities: async () => ({
				caps: {
					platform: {
						supports_h265: false,
						hardware_accelerated: false,
						max_resolution: "1080p",
					},
					encoder: {
						codecs: ["h264"],
						bitrate_range: { min: 500, max: 20000, unit: "kbps" },
					},
					sources: [],
				},
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
		});
		clearCapabilitiesCache();
		resetEngineDeviceCache();
	});
	afterEach(() => {
		delete getConfig().asrc;
	});

	function validateWith(asrc: string) {
		return validateConfig({
			delay: 0,
			pipeline: audioPipelineId,
			acodec: "opus",
			asrc,
			max_br: 5000,
			srt_latency: 2000,
			srtla_addr: "192.168.1.1",
			srtla_port: 5000,
		});
	}

	async function messageOf(promise: Promise<unknown>): Promise<string> {
		try {
			await promise;
			return "";
		} catch (err) {
			return (err as Error).message;
		}
	}

	test("rejects a genuinely unknown audio source (asrc gate reached)", async () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		expect(await messageOf(validateWith("totally-unknown-card-xyz"))).toContain(
			"Selected audio source not found",
		);
	});

	test("'Auto' passes the asrc membership gate even when absent from the device map", async () => {
		getConfig().asrc = "HDMI";
		expect(await messageOf(validateWith(AUDIO_SOURCE_AUTO))).not.toContain(
			"Selected audio source not found",
		);
	});
});

// ─── Engine start assembly — the launch copy feeds getAudioSrcId(asrcKey) ─────

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	streamid: "sid",
};

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

function makeFakeClient(): {
	client: CerastreamClient;
	calls: Array<{ op: string; params?: unknown }>;
} {
	const calls: Array<{ op: string; params?: unknown }> = [];
	const client = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.4.0",
			engine_version: "test",
		},
		start: async (params: unknown) => {
			calls.push({ op: "start", params });
			return { session_id: "s1", state: "streaming" as const };
		},
		stop: async () => ({ state: "idle" as const }),
		reloadConfig: async (params: unknown) => ({ applied: params }),
		setBitrate: async (params: { max_bitrate: number }) => ({
			applied: { max_bitrate: params.max_bitrate },
		}),
		switchInput: async (params: { input_id: string; mode: string }) => ({
			active_input: params.input_id,
			mode: params.mode as "manual" | "auto",
		}),
		listDevices: async () => ({ devices: [] }),
		subscribeEvents: async () => ({
			result: { subscribed: [] as never[] },
			close: () => {},
		}),
		previewSession: async () => ({
			session_id: "p1",
			tier: "webcodecs" as const,
			transport: {
				kind: "uds-binary" as const,
				socket: "/run/cerastream/preview.sock" as const,
			},
		}),
		close: async () => {},
	};
	return { client: client as unknown as CerastreamClient, calls };
}

async function startParamsFor(
	config: RuntimeConfig,
): Promise<Record<string, unknown>> {
	const fake = makeFakeClient();
	const backend = new CerastreamBackend({
		connect: async () => fake.client,
		connectOptions: {},
		getConfig: () => config,
		saveConfig: () => {},
		bridge: {
			notify: () => {},
			notificationExists: () => false,
			broadcastStatus: () => {},
			broadcastBuffering: () => {},
		},
		execPath: "cerastream",
		configPath: "/tmp/auto-audio-assembly.json",
		logger: silentLogger,
		getActiveInput: () => undefined,
		isEmbeddedAudioActive: () => false,
	});
	await backend.start(config, RUN_OPTS);
	await backend.settle();
	const started = fake.calls.find((c) => c.op === "start");
	return started?.params as Record<string, unknown>;
}

describe("Auto launch → engine start assembly", () => {
	const BASE: RuntimeConfig = {
		pipeline: "hdmi",
		max_br: 8000,
		srt_latency: 2000,
		balancer: "adaptive",
		selected_video_input: "/dev/video0",
		acodec: "opus",
		delay: 0,
	};

	test("HDMI resolution → engine start params carry audio.device 'rockchiphdmiin'", async () => {
		const launch = buildAutoLaunchConfig(
			{ ...BASE, asrc: AUDIO_SOURCE_AUTO },
			{ asrcKey: "HDMI", cardId: "rockchiphdmiin", reason: "hdmi" },
		);
		// The launch copy carries the asrcKey "HDMI"; the engine maps it via
		// getAudioSrcId → the card id, wrapped as an alsasrc `hw:CARD=<id>` string
		// (rk3588 test host).
		expect(launch.asrc).toBe("HDMI");
		const params = await startParamsFor(launch);
		expect((params.audio as { device: string }).device).toBe(
			"hw:CARD=rockchiphdmiin",
		);
	});

	test("Pipeline-default resolution → engine start params carry NO audio.device", async () => {
		const launch = buildAutoLaunchConfig(
			{ ...BASE, asrc: AUDIO_SOURCE_AUTO },
			{ asrcKey: "Pipeline default", cardId: null, reason: "pipeline-default" },
		);
		expect("asrc" in launch).toBe(false);
		const params = await startParamsFor(launch);
		expect((params.audio as { device?: string } | undefined)?.device).toBe(
			undefined,
		);
	});
});

// ─── maybeProbeAudioSource — probes the asrcKey, never the cardId ─────────────

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
	return {
		source: "hdmi",
		name: "hdmi",
		hardware: "rk3588",
		description: "",
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audio_kind: "selectable",
		...overrides,
	};
}

describe("maybeProbeAudioSource — probes the asrcKey, not the cardId", () => {
	test("asrcProbe is invoked with the asrcKey ('HDMI'), never the cardId", async () => {
		const probe = mock(async (_asrc: string) => "cardid");
		const launch = buildAutoLaunchConfig(
			{ pipeline: "hdmi", asrc: AUDIO_SOURCE_AUTO } as RuntimeConfig,
			{ asrcKey: "HDMI", cardId: "rockchiphdmiin", reason: "hdmi" },
		);
		const proceed = await maybeProbeAudioSource(pipeline(), launch, {
			probe,
			networkEmbeddedAudio: false,
		});
		expect(proceed).toBe(true);
		expect(probe).toHaveBeenCalledWith("HDMI");
		expect(probe).not.toHaveBeenCalledWith("rockchiphdmiin");
	});

	test("a pseudo (pipeline-default) launch skips the probe entirely", async () => {
		const probe = mock(async (_asrc: string) => "");
		const launch = buildAutoLaunchConfig(
			{ pipeline: "test", asrc: AUDIO_SOURCE_AUTO } as RuntimeConfig,
			{ asrcKey: "Pipeline default", cardId: null, reason: "pipeline-default" },
		);
		const proceed = await maybeProbeAudioSource(pipeline(), launch, {
			probe,
			networkEmbeddedAudio: false,
		});
		expect(proceed).toBe(true);
		expect(probe).not.toHaveBeenCalled();
	});
});

// ─── Live-state resolution + preview freshness / reload hydration ─────────────

async function seedUvcCaptureSource(): Promise<void> {
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

describe("refreshResolvedAsrcPreview — live-state freshness + reload hydration", () => {
	let broadcasts: Array<Record<string, unknown>>;

	beforeEach(async () => {
		resetAutoAudioState();
		updateStatus(false);
		clearCapabilitiesCache();
		resetEngineDeviceCache();
		await seedUvcCaptureSource();
		setMockAudioDevicesProvider(() => ({ "USB audio": "usbaudio" }));
		broadcasts = [];
		setAutoAudioBroadcaster((u) =>
			broadcasts.push(u as Record<string, unknown>),
		);
	});
	afterEach(() => {
		setAutoAudioBroadcaster(undefined);
		setMockAudioDevicesProvider(undefined);
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		resetAutoAudioState();
		updateStatus(false);
		delete getConfig().asrc;
		delete getConfig().source;
	});

	test("resolveAutoAsrcFromLiveState resolves the persisted source (USB → USB audio)", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "usb-cam-1";
		const r = resolveAutoAsrcFromLiveState();
		expect(r.asrcKey).toBe("USB audio");
		expect(r.cardId).toBe("usbaudio");
		expect(r.reason).toBe("usb-alias");
	});

	test("Freshness: a source change while Auto+idle re-broadcasts resolved_asrc immediately", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "usb-cam-1";
		refreshResolvedAsrcPreview();
		expect(getResolvedAsrc()).toBe("USB audio");
		expect(getResolvedAsrcReason()).toBe("usb-alias");
		expect(broadcasts).toEqual([
			{ resolved_asrc: "USB audio", resolved_asrc_reason: "usb-alias" },
		]);
	});

	test("Reload hydration: a fresh status snapshot carries the current resolved_asrc", () => {
		// buildInitialStatus() fires getSshStatus(), which reads setup.ssh_user; a
		// sibling test file may leave a malformed value, so clear it defensively.
		const sshHolder = setup as { ssh_user?: string };
		const savedSshUser = sshHolder.ssh_user;
		sshHolder.ssh_user = undefined;
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "usb-cam-1";
		refreshResolvedAsrcPreview();

		const snapshot = buildInitialStatus();
		expect(snapshot.status.resolved_asrc).toBe("USB audio");
		expect(snapshot.status.resolved_asrc_reason).toBe("usb-alias");
		expect(snapshot.status.pending_audio_follow_asrc).toBeNull();
		sshHolder.ssh_user = savedSshUser;
	});

	test("Full start proof: buildAutoLaunchConfig(getConfig(),…) never leaks into the persisted asrc", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "usb-cam-1";
		const resolution = resolveAutoAsrcFromLiveState();
		const launch = buildAutoLaunchConfig(getConfig(), resolution);
		expect(launch.asrc).toBe("USB audio");
		// config.json / getConfig().asrc is STILL "Auto" after resolution.
		expect(getConfig().asrc).toBe(AUDIO_SOURCE_AUTO);
	});
});

describe("updateAudioDevices initial enumeration", () => {
	let audioRoot: string | undefined;

	afterEach(() => {
		if (audioRoot !== undefined)
			rmSync(audioRoot, { recursive: true, force: true });
		audioRoot = undefined;
	});

	test("a missing audio directory resolves and publishes the empty-device state", async () => {
		audioRoot = mkdtempSync(join(tmpdir(), "auto-audio-missing-"));
		const cardDir = join(audioRoot, "card0");
		mkdirSync(cardDir);
		writeFileSync(join(cardDir, "id"), "usbaudio\n");
		await updateAudioDevices(audioRoot);
		expect(getAudioDevices()).toHaveProperty("USB audio", "usbaudio");

		rmSync(audioRoot, { recursive: true });
		await updateAudioDevices(audioRoot);

		expect(getAudioDevices()).toEqual({
			"No audio": "No audio",
			"Pipeline default": "Pipeline default",
		});
		expect(deriveAudioSources()).toEqual([
			{ id: "No audio", kind: "none", labelKey: "audio.sources.noAudio" },
			{
				id: "Pipeline default",
				kind: "pipeline_default",
				labelKey: "audio.sources.pipelineDefault",
			},
		]);
	});

	test("a non-ENOENT enumeration error still rejects", async () => {
		audioRoot = mkdtempSync(join(tmpdir(), "auto-audio-not-dir-"));
		const notDirectory = join(audioRoot, "audio-file");
		writeFileSync(notDirectory, "not a directory\n");
		const before = getAudioDevices();

		await expect(updateAudioDevices(notDirectory)).rejects.toThrow("ENOTDIR");
		expect(getAudioDevices()).toEqual(before);
	});
});

// ─── Lifecycle (b): a hotplug re-enumeration while streaming stays frozen ─────

describe("updateAudioDevices re-enumeration while streaming (Oracle R10-1)", () => {
	let audioDir: string | undefined;

	afterEach(() => {
		if (audioDir !== undefined)
			rmSync(audioDir, { recursive: true, force: true });
		audioDir = undefined;
		delete getConfig().asrc;
		setAutoAudioBroadcaster(undefined);
		resetAutoAudioState();
		updateStatus(false);
	});

	test("a hotplug updateAudioDevices() while STREAMING does NOT change resolved_asrc", async () => {
		audioDir = mkdtempSync(join(tmpdir(), "auto-audio-streaming-"));
		setResolvedAsrcFromStart("HDMI", "hdmi");
		updateStatus(true);
		const broadcasts: Array<Record<string, unknown>> = [];
		setAutoAudioBroadcaster((u) =>
			broadcasts.push(u as Record<string, unknown>),
		);
		getConfig().asrc = AUDIO_SOURCE_AUTO;

		await updateAudioDevices(audioDir);

		expect(getResolvedAsrc()).toBe("HDMI");
		expect(getResolvedAsrcReason()).toBe("hdmi");
		expect(broadcasts).toEqual([]);
	});
});
