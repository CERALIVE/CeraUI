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
	getAudioSrcId,
	reconcileConfiguredAudioIdentity,
	resolveAudioMode,
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
	physicalGroupId?: string,
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
		...(physicalGroupId !== undefined ? { physicalGroupId } : {}),
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
	physicalGroupId?: string,
): EngineAudioDevice {
	return {
		input_id: inputId,
		display_name: displayName,
		...(alsaCardId !== undefined ? { alsa_card_id: alsaCardId } : {}),
		...(physicalGroupId !== undefined
			? { physical_group_id: physicalGroupId }
			: {}),
	};
}

/** The rk3588 audio map produced by audio.ts on the test host (setup.hw). */
const HDMI_MAP: Record<string, string> = {
	HDMI: "rockchiphdmiin",
	"No audio": "No audio",
	"Pipeline default": "Pipeline default",
};
/**
 * The SAME HDMI-RX capture card as `HDMI_MAP`, as the mainline / Armbian `edge`
 * 7.1 kernel registers it: card id `hdmirx` (the first-party `simple-audio-card`
 * DT node over the Synopsys receiver), with no alias, so the asrcKey IS the id.
 */
const HDMIRX_MAP: Record<string, string> = {
	hdmirx: "hdmirx",
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

	test("Rule 5: exactly ONE same-group audio candidate → auto-pick, usb-same-device", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource(
					"uvc_h264",
					"RØDE Streamer X",
					"RØDE Streamer X",
					"usb:10-1",
				),
				audioDevices: {
					"RØDE Streamer Audio": "rodecard",
					"USB audio": "usbaudio",
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [
					engineAudio("RØDE Streamer Mic", "rodecard", undefined, "usb:10-1"),
					// A separately-plugged USB mic on a DIFFERENT physical device.
					engineAudio("Some Other Mic", "usbaudio", undefined, "usb:3-2"),
				],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "RØDE Streamer Audio",
			cardId: "rodecard",
			reason: "usb-same-device",
		});
	});

	test("Rule 5: MORE THAN ONE same-group candidate → ambiguous, NO auto-pick", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource(
					"uvc_h264",
					"Composite Capture",
					"Composite Capture",
					"usb:5-1",
				),
				audioDevices: {
					"Capture A": "capa",
					"Capture B": "capb",
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [
					engineAudio("Capture A", "capa", undefined, "usb:5-1"),
					engineAudio("Capture B", "capb", undefined, "usb:5-1"),
				],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: null,
			cardId: null,
			reason: "ambiguous-same-device-audio",
			candidates: ["Capture A", "Capture B"],
		});
	});

	test("Rule 5: ZERO same-group candidates → no-same-device-audio, NEVER a cross-device guess", () => {
		const r = resolveAutoAsrc({
			source: captureSource(
				"uvc_h264",
				"RØDE Streamer X",
				"RØDE Streamer X",
				"usb:10-1",
			),
			audioDevices: {
				"Some Other Mic": "usbaudio",
				"No audio": "No audio",
				"Pipeline default": "Pipeline default",
			},
			engineAudio: [
				engineAudio("Some Other Mic", "usbaudio", undefined, "usb:3-2"),
			],
			networkEmbeddedAudio: undefined,
		});
		expect(r).toEqual({
			asrcKey: null,
			cardId: null,
			reason: "no-same-device-audio",
		});
		// The negative control: the other device's microphone is never adopted.
		expect(r.asrcKey).not.toBe("Some Other Mic");
	});

	test("Rule 5: a camera with NO group never matches — not even another group-less card (ADR-0008 §6)", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("uvc_h264", "Legacy Cam"),
				audioDevices: {
					"Onboard Audio": "rockchipes8388x",
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [engineAudio("Onboard Audio", "rockchipes8388x")],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: null,
			cardId: null,
			reason: "no-same-device-audio",
		});
	});

	test("Rule 5: a group-less AUDIO card never matches a grouped camera", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("usb", "Generic USB Cam", "cam", "usb:1-1"),
				audioDevices: {
					"Onboard Audio": "rockchipes8388x",
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [engineAudio("Onboard Audio", "rockchipes8388x")],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: null,
			cardId: null,
			reason: "no-same-device-audio",
		});
	});

	test("Rule 5: an EMPTY-STRING group is an absent group on both sides", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("usb", "Generic USB Cam", "cam", ""),
				audioDevices: {
					"Some Mic": "somecard",
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [engineAudio("Some Mic", "somecard", undefined, "")],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: null,
			cardId: null,
			reason: "no-same-device-audio",
		});
	});

	test("Rule 5: a same-group card CeraUI does not enumerate is no candidate at all", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("uvc_h264", "Osmo", "osmo", "usb:5-1"),
				audioDevices: {
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [
					engineAudio("Osmo Mic", "DJIPocket3", undefined, "usb:5-1"),
				],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: null,
			cardId: null,
			reason: "no-same-device-audio",
		});
	});

	test("Rule 5: an engine audio entry with NO alsa_card_id can never be a candidate", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("uvc_h264", "Osmo", "osmo", "usb:5-1"),
				audioDevices: USB_MAP,
				engineAudio: [engineAudio("Osmo Mic", undefined, undefined, "usb:5-1")],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: null,
			cardId: null,
			reason: "no-same-device-audio",
		});
	});

	// The exact board topology a Rock 5B+ reports (todo 8 board proof): the Osmo
	// Pocket 3's video and audio rows BOTH carry `usb:5-1`, the RØDE's both carry
	// `usb:10-1`, and the HDMI-RX carries no group key at all.
	const OSMO_VIDEO_NAME = "DJIPocket3: OsmoPocket3";
	const OSMO_AUDIO_LONGNAME =
		"DJI DJIPocket3 at usb-fc880000.usb-1, high speed";
	const RODE_AUDIO_LONGNAME =
		"RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed";
	const OSMO_BOARD_MAP = {
		HDMI: "rockchiphdmiin",
		"USB audio": "usbaudio",
		DJIPocket3: "DJIPocket3",
		"No audio": "No audio",
		"Pipeline default": "Pipeline default",
	};
	const OSMO_BOARD_ENGINE_AUDIO: EngineAudioDevice[] = [
		{
			input_id: OSMO_AUDIO_LONGNAME,
			display_name: OSMO_AUDIO_LONGNAME,
			alsa_card_id: "DJIPocket3",
			product_name: "DJIPocket3",
			physical_group_id: "usb:5-1",
		},
		{
			input_id: RODE_AUDIO_LONGNAME,
			display_name: RODE_AUDIO_LONGNAME,
			alsa_card_id: "usbaudio",
			product_name: "usbaudio",
			physical_group_id: "usb:10-1",
		},
	];

	test("Board: Osmo cam + Auto → the Osmo's OWN audio, by group", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource(
					"uvc_h264",
					OSMO_VIDEO_NAME,
					OSMO_VIDEO_NAME,
					"usb:5-1",
				),
				audioDevices: OSMO_BOARD_MAP,
				engineAudio: OSMO_BOARD_ENGINE_AUDIO,
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "DJIPocket3",
			cardId: "DJIPocket3",
			reason: "usb-same-device",
		});
	});

	test("Board: RØDE cam + Auto → the RØDE's OWN audio, by group", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("uvc_h264", "RØDE HDMI", "rode", "usb:10-1"),
				audioDevices: OSMO_BOARD_MAP,
				engineAudio: OSMO_BOARD_ENGINE_AUDIO,
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: "USB audio",
			cardId: "usbaudio",
			reason: "usb-same-device",
		});
	});

	test("Rule 6 (QA failure): USB capture + ZERO audio cards → no-same-device-audio", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("usb", "Generic USB Cam", "cam", "usb:1-1"),
				audioDevices: {
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({
			asrcKey: null,
			cardId: null,
			reason: "no-same-device-audio",
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

	test("M3: USB cam + second USB mic → Auto resolves to the cam's OWN audio (same physical group); both offered with distinct real labels", () => {
		const engine = [
			engineAudio("RØDE Streamer Mic", "rode_card", undefined, "usb:10-1"),
			engineAudio("Elgato Wave:3", "elgato_wave3", undefined, "usb:3-2"),
		];
		expect(
			resolveAutoAsrc({
				source: captureSource(
					"uvc_h264",
					"RØDE Streamer X",
					"RØDE Streamer X",
					"usb:10-1",
				),
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

	test("M5: the resolved audio card disappears → Auto reports no-same-device-audio; the input map is NOT mutated", () => {
		const afterUnplug: Record<string, string> = {
			"Some Card": "somecard",
			"No audio": "No audio",
			"Pipeline default": "Pipeline default",
		};
		const snapshot = structuredClone(afterUnplug);
		const r = resolveAutoAsrc({
			source: captureSource("usb", "Generic USB Cam", "cam", "usb:1-1"),
			audioDevices: afterUnplug,
			engineAudio: [],
			networkEmbeddedAudio: undefined,
		});
		expect(r).toEqual({
			asrcKey: null,
			cardId: null,
			reason: "no-same-device-audio",
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

	test("USB same-device → { asrcKey: 'USB audio', cardId: 'usbaudio' }", () => {
		const r = resolveAutoAsrc({
			source: captureSource("usb", "Generic USB Cam", "cam", "usb:3-2"),
			audioDevices: USB_MAP,
			engineAudio: [
				engineAudio("Generic USB Cam Mic", "usbaudio", undefined, "usb:3-2"),
			],
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
				resolved_asrc_candidates: null,
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
				resolved_asrc_candidates: null,
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
			removeNotification: () => {},
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
						physical_group_id: "usb:10-1",
					},
					{
						input_id: "usb-audio-1",
						device_path: "",
						display_name: "RØDE AI-Micro",
						media_class: "audio",
						kind: "audio",
						alsa_card_id: "Micro",
						physical_group_id: "usb:10-1",
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
		setMockAudioDevicesProvider(() => ({ "RØDE AI-Micro": "Micro" }));
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

	test("resolveAutoAsrcFromLiveState resolves the persisted source to its OWN card", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "usb-cam-1";
		const r = resolveAutoAsrcFromLiveState();
		expect(r.asrcKey).toBe("RØDE AI-Micro");
		expect(r.cardId).toBe("Micro");
		expect(r.reason).toBe("usb-same-device");
	});

	test("Freshness: a source change while Auto+idle re-broadcasts resolved_asrc immediately", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "usb-cam-1";
		refreshResolvedAsrcPreview();
		expect(getResolvedAsrc()).toBe("RØDE AI-Micro");
		expect(getResolvedAsrcReason()).toBe("usb-same-device");
		expect(broadcasts).toEqual([
			{
				resolved_asrc: "RØDE AI-Micro",
				resolved_asrc_reason: "usb-same-device",
				resolved_asrc_candidates: null,
			},
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
		expect(snapshot.status.resolved_asrc).toBe("RØDE AI-Micro");
		expect(snapshot.status.resolved_asrc_reason).toBe("usb-same-device");
		expect(snapshot.status.pending_audio_follow_asrc).toBeNull();
		sshHolder.ssh_user = savedSshUser;
	});

	test("Full start proof: buildAutoLaunchConfig(getConfig(),…) never leaks into the persisted asrc", () => {
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "usb-cam-1";
		const resolution = resolveAutoAsrcFromLiveState();
		const launch = buildAutoLaunchConfig(getConfig(), resolution);
		expect(launch.asrc).toBe("RØDE AI-Micro");
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

// ─── Manual precedence + saved-selection migration (todo 13) ─────────────────

describe("manual asrc always wins over the same-device resolver", () => {
	beforeEach(async () => {
		resetAutoAudioState();
		updateStatus(false);
		clearCapabilitiesCache();
		resetEngineDeviceCache();
		await seedUvcCaptureSource();
		setMockAudioDevicesProvider(() => ({
			"RØDE AI-Micro": "Micro",
			"Elgato Wave:3": "elgato_wave3",
		}));
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

	test("a manual pick is never overwritten by the preview resolver", () => {
		const broadcasts: Array<Record<string, unknown>> = [];
		setAutoAudioBroadcaster((u) =>
			broadcasts.push(u as Record<string, unknown>),
		);
		getConfig().asrc = "Elgato Wave:3";
		getConfig().source = "usb-cam-1";

		refreshResolvedAsrcPreview();

		expect(getConfig().asrc).toBe("Elgato Wave:3");
		expect(getResolvedAsrc()).toBeNull();
		expect(getResolvedAsrcReason()).toBeNull();
		expect(broadcasts).toEqual([]);
	});

	test("a manual pick survives an AMBIGUOUS same-group situation untouched", () => {
		getConfig().asrc = "Elgato Wave:3";
		const ambiguous = resolveAutoAsrc({
			source: captureSource("uvc_h264", "Composite", "composite", "usb:5-1"),
			audioDevices: { "Capture A": "capa", "Capture B": "capb" },
			engineAudio: [
				engineAudio("Capture A", "capa", undefined, "usb:5-1"),
				engineAudio("Capture B", "capb", undefined, "usb:5-1"),
			],
			networkEmbeddedAudio: undefined,
		});
		expect(ambiguous.reason).toBe("ambiguous-same-device-audio");
		expect(getConfig().asrc).toBe("Elgato Wave:3");
	});

	test("migration: a saved manual asrc still routes through the unchanged card path", () => {
		getConfig().asrc = "RØDE AI-Micro";
		expect(resolveAudioMode("RØDE AI-Micro", false)).toEqual({
			mode: "device",
			device: `hw:CARD=${getAudioSrcId("RØDE AI-Micro")}`,
		});
	});

	test("migration: a saved manual asrc renumbered across a replug follows its stable identity", () => {
		getConfig().asrc = "Old Card Name";
		const migrated = reconcileConfiguredAudioIdentity(
			new Map([["RØDE AI-Micro", { stable_id: "card:Micro" }]]),
			{ "RØDE AI-Micro": "Micro" },
			new Map([["Old Card Name", "card:Micro"]]),
		);
		expect(migrated).toBe(true);
		expect(getConfig().asrc).toBe("RØDE AI-Micro");
	});
});

// ─── W4A4-F1: a bound card must be able to CAPTURE ───────────────────────────
//
// Found on a Rock 5B+ during wave-4 board QA (task-4 §5b). With a LOCKED
// 1080p59.94 signal on the HDMI-RX port, rule 3 bound "Auto" to
// `rockchiphdmiin` because the card is ENUMERATED — and that card owns no
// capture PCM substream at all:
//
//   /proc/asound/cards  3 [rockchiphdmiin ]: rockchip_hdmiin - rockchip,hdmiin
//   /proc/asound/pcm    03-00: rockchip,hdmiin i2s-hifi-0 :      <-- no `capture N`
//   arecord -l          card 4 only
//
// So EVERY `asrc: "Auto"` start on the HDMI source died with
// `-32602 audio-device-unavailable: ALSA capture device 'hw:CARD=rockchiphdmiin'
// is busy or unavailable`, classified `start_invalid` / `not_retriable`. The
// capture-PCM presence set already existed in-repo (`hasCapturePcmNode` /
// `audioCaptureCardIds`, consumed by the audio meter) — rule 3 simply never
// consulted it.
describe("resolveAutoAsrc — a bound card must be able to CAPTURE (W4A4-F1)", () => {
	const CAPTURE_CAPABLE = new Set(["usbaudio", "rockchipes8316"]);

	test("Rule 3: the HDMI card is enumerated but owns NO capture PCM → no pick", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI Input"),
				audioDevices: HDMI_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
				captureCapableCardIds: CAPTURE_CAPABLE,
			}),
		).toEqual({
			asrcKey: "No audio",
			cardId: null,
			reason: "no-capture-audio",
		});
	});

	test("Rule 3 control: the same card WITH a capture PCM still binds (unchanged)", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI Input"),
				audioDevices: HDMI_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
				captureCapableCardIds: new Set(["rockchiphdmiin"]),
			}),
		).toEqual({ asrcKey: "HDMI", cardId: "rockchiphdmiin", reason: "hdmi" });
	});

	test("fail-open: an UNKNOWN capture set never suppresses a bind", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI Input"),
				audioDevices: HDMI_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({ asrcKey: "HDMI", cardId: "rockchiphdmiin", reason: "hdmi" });
	});

	test("Rule 4: a Cam Link card with no capture PCM gets the same refusal", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("camlink", "Cam Link 4K"),
				audioDevices: CAMLINK_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
				captureCapableCardIds: CAPTURE_CAPABLE,
			}),
		).toEqual({
			asrcKey: "No audio",
			cardId: null,
			reason: "no-capture-audio",
		});
	});

	test("an UN-ENUMERATED HDMI card still falls to pipeline default (unchanged)", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI Input"),
				audioDevices: {
					"No audio": "No audio",
					"Pipeline default": "Pipeline default",
				},
				engineAudio: [],
				networkEmbeddedAudio: undefined,
				captureCapableCardIds: CAPTURE_CAPABLE,
			}),
		).toEqual({
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
	});

	// The whole point: the launch copy must ask the engine for an explicit
	// video-only stream instead of a dead ALSA card. `audio.mode: "none"` is what
	// makes the start SUCCEED where the board recorded `audio-device-unavailable`.
	test("the launch copy asks the engine for mode:none, never the dead card", () => {
		const resolution = resolveAutoAsrc({
			source: captureSource("hdmi", "HDMI Input"),
			audioDevices: HDMI_MAP,
			engineAudio: [],
			networkEmbeddedAudio: undefined,
			captureCapableCardIds: CAPTURE_CAPABLE,
		});
		const launch = buildAutoLaunchConfig(
			{
				asrc: AUDIO_SOURCE_AUTO,
				pipeline: "hdmi",
				max_br: 5000,
			} as RuntimeConfig,
			resolution,
		);
		expect(launch.asrc).toBe("No audio");
		expect(resolveAudioMode(launch.asrc ?? "", false)).toEqual({
			mode: "none",
		});
	});
});

// ─── The HDMI-RX card under BOTH kernel-track spellings ──────────────────────
//
// The hardware does not choose which card id it gets — the KERNEL TRACK does.
// The Rockchip vendor 6.1 BSP registers the HDMI-RX audio half as
// `rockchiphdmiin`; the mainline / Armbian `edge` 7.1 tree registers the SAME
// physical port as `hdmirx`, through the Synopsys receiver plus a first-party
// `simple-audio-card` DT node. Board-proven on a Rock 5B+ running
// `7.1.5-ceralive-rk3588` with kernel-patches PR #2 applied:
//
//   /proc/asound/cards  2 [hdmirx] : simple-card - hdmirx
//   /proc/asound/pcm    fddf8000.i2s-i2s-hifi … : capture 1
//   ffmpeg hw:2,0       mean_volume: -29.0 dB       <-- real, non-silent audio
//
// With one spelling hardcoded, rule 3's lookup missed, fell silently through,
// and "Auto" NEVER bound HDMI audio on that kernel — for hardware that
// demonstrably captures.
describe("resolveAutoAsrc — the HDMI-RX card under BOTH kernel spellings", () => {
	test("Rule 3: the mainline `hdmirx` card binds exactly like `rockchiphdmiin`", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI Input"),
				audioDevices: HDMIRX_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
				captureCapableCardIds: new Set(["hdmirx"]),
			}),
		).toEqual({ asrcKey: "hdmirx", cardId: "hdmirx", reason: "hdmi" });
	});

	test("fail-open on `hdmirx` too: an UNKNOWN capture set never suppresses the bind", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI Input"),
				audioDevices: HDMIRX_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
			}),
		).toEqual({ asrcKey: "hdmirx", cardId: "hdmirx", reason: "hdmi" });
	});

	// The gate is NOT weakened by the second spelling: it is asked about whichever
	// card id matched, so a listed-but-unrecordable `hdmirx` is refused exactly as
	// the listed-but-unrecordable `rockchiphdmiin` above it.
	test("Rule 3: an enumerated `hdmirx` owning NO capture PCM is refused, not bound", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI Input"),
				audioDevices: HDMIRX_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
				captureCapableCardIds: new Set(["usbaudio"]),
			}),
		).toEqual({
			asrcKey: "No audio",
			cardId: null,
			reason: "no-capture-audio",
		});
	});

	test("a refused `hdmirx` launches as an explicit video-only stream (mode:none)", () => {
		const resolution = resolveAutoAsrc({
			source: captureSource("hdmi", "HDMI Input"),
			audioDevices: HDMIRX_MAP,
			engineAudio: [],
			networkEmbeddedAudio: undefined,
			captureCapableCardIds: new Set(["usbaudio"]),
		});
		const launch = buildAutoLaunchConfig(
			{
				asrc: AUDIO_SOURCE_AUTO,
				pipeline: "hdmi",
				max_br: 5000,
			} as RuntimeConfig,
			resolution,
		);
		expect(launch.asrc).toBe("No audio");
		expect(resolveAudioMode(launch.asrc ?? "", false)).toEqual({
			mode: "none",
		});
	});

	// Order is the resolver's contract, so a board that somehow listed both never
	// depends on device-map iteration order.
	test("a board listing BOTH spellings resolves deterministically to the vendor one", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI Input"),
				audioDevices: { ...HDMIRX_MAP, ...HDMI_MAP },
				engineAudio: [],
				networkEmbeddedAudio: undefined,
				captureCapableCardIds: new Set(["rockchiphdmiin", "hdmirx"]),
			}),
		).toEqual({ asrcKey: "HDMI", cardId: "rockchiphdmiin", reason: "hdmi" });
	});

	test("the vendor board is untouched: `rockchiphdmiin` still binds with no `hdmirx` in sight", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("hdmi", "HDMI capture"),
				audioDevices: HDMI_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
				captureCapableCardIds: new Set(["rockchiphdmiin"]),
			}),
		).toEqual({ asrcKey: "HDMI", cardId: "rockchiphdmiin", reason: "hdmi" });
	});

	// The negative control: widening rule 3's id list must not widen which SOURCES
	// it answers for. A Cam Link with only the HDMI-RX card present picks nothing.
	test("a non-HDMI source is never bound to the `hdmirx` card", () => {
		expect(
			resolveAutoAsrc({
				source: captureSource("camlink", "Cam Link 4K"),
				audioDevices: HDMIRX_MAP,
				engineAudio: [],
				networkEmbeddedAudio: undefined,
				captureCapableCardIds: new Set(["hdmirx"]),
			}),
		).toEqual({
			asrcKey: "Pipeline default",
			cardId: null,
			reason: "pipeline-default",
		});
	});
});

/** The board's own HDMI-RX row: `rk_hdmirx` on `/dev/video0`, kind `hdmi`. */
async function seedHdmiCaptureSource(): Promise<void> {
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
	await refreshEngineDeviceCache({
		fetchEngineDevices: async () =>
			({
				devices: [
					{
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
					},
				],
			}) as unknown as ListDevicesResult,
	});
}

// The pure table above proves the RULE; this proves the WIRING — the live-state
// resolver must actually feed it the scan's capture-PCM set. A board-shaped
// sysfs fixture is the only honest input: `audioDevices` and the capture set are
// produced by the SAME `updateAudioDevices` pass, so a fixture that lists the
// card without a `pcmC3D0c` node reproduces the board exactly.
describe("Auto on the board's real HDMI topology (W4A4-F1 wiring)", () => {
	let audioRoot: string | undefined;

	async function scanCards(
		cards: Array<{ dir: string; id: string; entries?: string[] }>,
	): Promise<void> {
		if (audioRoot !== undefined)
			rmSync(audioRoot, { recursive: true, force: true });
		audioRoot = mkdtempSync(join(tmpdir(), "w4a4f1-audio-"));
		for (const card of cards) {
			const dir = join(audioRoot, card.dir);
			mkdirSync(dir);
			writeFileSync(join(dir, "id"), `${card.id}\n`);
			for (const entry of card.entries ?? []) mkdirSync(join(dir, entry));
		}
		await updateAudioDevices(audioRoot);
	}

	beforeEach(async () => {
		resetAutoAudioState();
		updateStatus(false);
		clearCapabilitiesCache();
		resetEngineDeviceCache();
		await seedHdmiCaptureSource();
		getConfig().asrc = AUDIO_SOURCE_AUTO;
		getConfig().source = "/dev/video0";
	});
	afterEach(async () => {
		if (audioRoot !== undefined) {
			rmSync(audioRoot, { recursive: true, force: true });
			audioRoot = undefined;
		}
		await updateAudioDevices("/nonexistent-audio-root");
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		resetAutoAudioState();
		updateStatus(false);
		delete getConfig().asrc;
		delete getConfig().source;
	});

	test("the enumerated-but-capture-less HDMI card is refused, not bound", async () => {
		// Exactly the board: card3 lists, owns no PCM node at all.
		await scanCards([
			{ dir: "card3", id: "rockchiphdmiin" },
			{ dir: "card5", id: "usbaudio", entries: ["pcmC5D0c"] },
		]);
		expect(getAudioDevices()).toHaveProperty("HDMI", "rockchiphdmiin");

		const r = resolveAutoAsrcFromLiveState();
		expect(r.reason).toBe("no-capture-audio");
		expect(r.cardId).toBeNull();
		expect(r.asrcKey).toBe("No audio");
	});

	test("once the card DOES own a capture PCM, rule 3 binds it again", async () => {
		await scanCards([
			{ dir: "card3", id: "rockchiphdmiin", entries: ["pcmC3D0c"] },
		]);
		const r = resolveAutoAsrcFromLiveState();
		expect(r.reason).toBe("hdmi");
		expect(r.cardId).toBe("rockchiphdmiin");
	});

	// The same two states on the mainline / edge-7.1 kernel, whose card tree the
	// board actually reports as `2 [hdmirx]` with a live `capture 1` substream.
	// The video half of the fixture is unchanged — it is one physical port, and
	// only the AUDIO card id moved.
	test("the edge-7.1 `hdmirx` card with a capture PCM binds through the live resolver", async () => {
		await scanCards([
			{ dir: "card2", id: "hdmirx", entries: ["pcmC2D0c"] },
			{ dir: "card0", id: "usbaudio", entries: ["pcmC0D0c"] },
		]);
		expect(getAudioDevices()).toHaveProperty("hdmirx", "hdmirx");

		const r = resolveAutoAsrcFromLiveState();
		expect(r.reason).toBe("hdmi");
		expect(r.cardId).toBe("hdmirx");
		expect(r.asrcKey).toBe("hdmirx");
	});

	test("an enumerated `hdmirx` with NO capture PCM is refused, exactly like the vendor card", async () => {
		await scanCards([
			{ dir: "card2", id: "hdmirx" },
			{ dir: "card0", id: "usbaudio", entries: ["pcmC0D0c"] },
		]);
		expect(getAudioDevices()).toHaveProperty("hdmirx", "hdmirx");

		const r = resolveAutoAsrcFromLiveState();
		expect(r.reason).toBe("no-capture-audio");
		expect(r.cardId).toBeNull();
		expect(r.asrcKey).toBe("No audio");
	});
});
