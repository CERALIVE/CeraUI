/*
 * Last-streamed-config retention: the device of the LAST-STREAMED configuration
 * is the ONLY one remembered as a `lost` row while it is absent. Starting a
 * stream with a different configuration SUPERSEDES that slot; a device that was
 * merely enumerated leaves the list once it is live-absent, keeping only its
 * invisible `last_seen_devices` entry for identity migration.
 *
 * POLICY CHANGE — the expectations this file previously held for in-session
 * retention were REPLACED, not weakened (Rule E). The retired rule remembered
 * every device the process had ever enumerated, uncapped, for the lifetime of
 * the backend: an accessory unplugged once and taken away kept a permanent
 * unavailable row in the picker. Merely having been SEEN is not evidence that
 * anyone wants a device back — going live with it is. The replaced assertions
 * asserted the old rule directly (a session-seen non-configured device
 * synthesizing a lost row), so there was no way to state the new policy without
 * contradicting them. Every property that was not about WHICH devices are
 * remembered — one row per remembered input, no coarse duplicate, the persisted
 * LRU cap, the hotplug/probe ordering rules — is still asserted below.
 *
 * The state-transition table this policy is defined by has one dedicated test
 * per row, under "the state-transition table".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type GetCapabilitiesResult,
	type ListDevicesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type {
	CaptureDevice,
	DeviceKind,
	NetworkIngest,
} from "@ceraui/rpc/schemas";
import { streamSourceSchema } from "@ceraui/rpc/schemas";

import {
	type LastSeenDevice,
	RUNTIME_CONFIG_DEFAULTS,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import {
	applyObservedDevicesAndBroadcast,
	applyObservedEngineDevices,
	buildSources,
	getEngineAudioDevices,
	getEngineDeviceCache,
	getSessionSeenDeviceSnapshots,
	getSourcesMessage,
	mergeObservedWithProbe,
	noteStreamedSourceCommitted,
	refreshAndBroadcastSources,
	refreshEngineDeviceCache,
	refreshSourcesForHotplug,
	resetEngineDeviceCache,
	setEngineAudioChangeHandler,
} from "../modules/streaming/sources.ts";
import { StreamStartFailure } from "../modules/streaming/start-failure-taxonomy.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

type CapabilitySource = GetCapabilitiesResult["sources"][number];

function capSource(
	id: string,
	overrides: Partial<CapabilitySource> = {},
): CapabilitySource {
	return {
		id,
		supports_audio: overrides.supports_audio ?? false,
		supports_resolution_override:
			overrides.supports_resolution_override ?? true,
		supports_framerate_override: overrides.supports_framerate_override ?? true,
		default_resolution: overrides.default_resolution ?? "1080p",
		default_framerate: overrides.default_framerate ?? 30,
	};
}

const GOLDEN_SOURCE_IDS = [
	"hdmi",
	"usb_mjpeg",
	"v4l_mjpeg",
	"camlink",
	"libuvch264",
	"rtmp",
	"srt",
	"test",
] as const;

function goldenCapSources(): CapabilitySource[] {
	return GOLDEN_SOURCE_IDS.map((id) => capSource(id));
}

function captureDevice(
	input_id: string,
	kind: DeviceKind,
	overrides: Partial<CaptureDevice> = {},
): CaptureDevice {
	return {
		input_id,
		device_path: overrides.device_path ?? `/dev/${input_id}`,
		display_name: overrides.display_name ?? input_id,
		media_class: overrides.media_class ?? "video",
		kind,
		...(overrides.caps !== undefined ? { caps: overrides.caps } : {}),
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
		devicePath: overrides.devicePath ?? `/dev/${id}`,
		...(overrides.stableId !== undefined
			? { stableId: overrides.stableId }
			: {}),
		...(overrides.previousIds !== undefined
			? { previousIds: overrides.previousIds }
			: {}),
	};
}

const NO_INGEST: NetworkIngest = { rtmp: null, srt: null };

/** One engine `list-devices` video entry (feeds refreshEngineDeviceCache). */
function engineDevice(
	input_id: string,
	displayName = input_id,
): ListDevicesResult["devices"][number] {
	return {
		input_id,
		device_path: `/dev/${input_id}`,
		display_name: displayName,
		media_class: "video",
		kind: "hdmi",
	};
}

function clearRetentionConfig(): void {
	const config = getConfig();
	config.last_seen_devices = [];
	delete config.source;
	delete config.source_stable_id;
	delete config.last_streamed_source;
	delete config.last_streamed_source_stable_id;
}

// ─── the projection: only the remembered device becomes a row ─────────────────

describe("buildSources — only the LAST-STREAMED device is remembered", () => {
	it("the remembered device, absent → EXACTLY one row (lost, unavailable, named from its snapshot), no coarse duplicate", () => {
		const snapshot = lastSeen("video0", "hdmi", "hdmi", {
			displayName: "Magewell HDMI Capture",
		});
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastStreamedSource: "video0",
			lastSeenDevices: [snapshot],
		});

		const rows = sources.filter((s) => s.id === "video0");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.origin).toBe("capture");
		expect(row?.lost).toBe(true);
		expect(row?.available).toBe(false);
		if (row?.origin === "capture") {
			expect(row.displayName).toBe("Magewell HDMI Capture");
			expect(row.devicePath).toBe("/dev/video0");
			expect(row.kind).toBe("hdmi");
		}

		// the hdmi coarse base slot is GONE (replaced by the lost row).
		expect(sources.some((s) => s.origin === "coarse" && s.id === "hdmi")).toBe(
			false,
		);
		expect(
			sources.filter((s) => s.origin === "coarse").map((s) => s.id),
		).toEqual([]);
	});

	it("a device that was SEEN but never streamed, absent → NO row at all", () => {
		// The whole point of the policy. Both devices are remembered in
		// `last_seen_devices` and both are live-absent; only the streamed one is a
		// row, and the other's metadata stays for identity migration.
		const streamed = lastSeen("video0", "hdmi", "hdmi");
		const merelySeen = lastSeen("video2", "hdmi", "hdmi", {
			displayName: "Session Cam",
		});
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastStreamedSource: "video0",
			lastSeenDevices: [streamed, merelySeen],
		});

		expect(sources.find((s) => s.id === "video0")?.lost).toBe(true);
		expect(sources.some((s) => s.id === "video2")).toBe(false);
	});

	it("the operator's CURRENT selection is not the anchor — a never-streamed selection yields no row", () => {
		// `config.source` moves freely on a save-only edit; the slot does not, and
		// this is the projection half of that separation.
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastSeenDevices: [lastSeen("video0", "hdmi", "hdmi")],
		});
		expect(sources.some((s) => s.id === "video0")).toBe(false);
	});

	it("replug → the lost row is replaced by the live row in one rebuild", () => {
		const snapshot = lastSeen("video0", "hdmi", "hdmi", {
			displayName: "Magewell HDMI Capture",
		});
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [
				captureDevice("video0", "hdmi", {
					display_name: "Magewell HDMI Capture",
				}),
			],
			networkIngest: NO_INGEST,
			lastStreamedSource: "video0",
			lastSeenDevices: [snapshot],
		});

		const rows = sources.filter((s) => s.id === "video0");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.origin).toBe("capture");
		expect(rows[0]?.available).toBe(true);
		expect(rows[0]?.lost).toBeUndefined();
	});

	it("a snapshot whose pipelineId is absent from the current coarse set synthesizes NO row", () => {
		const snapshot = lastSeen("video0", "hdmi", "hdmi");
		const sources = buildSources({
			// hdmi is NOT offered this build (caps changed), so nothing bridges to it.
			sources: [capSource("usb_mjpeg"), capSource("test")],
			devices: [],
			networkIngest: NO_INGEST,
			lastStreamedSource: "video0",
			lastSeenDevices: [snapshot],
		});
		expect(sources.some((s) => s.id === "video0")).toBe(false);
		// `usb_mjpeg` is a suppressed USB-capture placeholder, so only the virtual
		// test-pattern row remains.
		expect(sources.map((s) => s.id)).toEqual(["test"]);
	});

	it("a slot pointing at a device no longer remembered at all synthesizes NO row (no zombie)", () => {
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastStreamedSource: "video9",
			lastSeenDevices: [lastSeen("video0", "hdmi", "hdmi")],
		});
		expect(sources.some((s) => s.id === "video9")).toBe(false);
	});

	it("every synthesized lost row parses under streamSourceSchema with devicePath present", () => {
		const snapshot = lastSeen("video0", "hdmi", "hdmi", {
			displayName: "Elgato Cam Link 4K",
			devicePath: "/dev/video7",
		});
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastStreamedSource: "video0",
			lastSeenDevices: [snapshot],
		});
		for (const source of sources) {
			expect(() => streamSourceSchema.parse(source)).not.toThrow();
		}
		const lost = sources.find((s) => s.id === "video0");
		expect(lost?.origin).toBe("capture");
		if (lost?.origin === "capture") {
			expect(lost.devicePath).toBe("/dev/video7");
			expect(lost.lost).toBe(true);
		}
	});

	it("an anchored IDENTITY outranks the node path, and a path another device inherited never resolves", () => {
		// `/dev/video1` is now held outright by a different camera's snapshot, which
		// `findRememberingId` would prefer. Remembering THAT device would put a
		// stranger's row in the picker under the operator's own retention slot.
		const anchored = lastSeen("video4", "uvc_h264", "libuvch264", {
			displayName: "DJI Osmo Pocket 3",
			stableId: "usb:2ca3:0023:SN-A",
			previousIds: ["video1"],
		});
		const inheritor = lastSeen("video1", "mjpeg", "usb_mjpeg", {
			displayName: "Some Other Camera",
			stableId: "usb:19f7:0080:SN-B",
		});

		const byIdentity = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastStreamedSource: "video1",
			lastStreamedStableId: "usb:2ca3:0023:SN-A",
			lastSeenDevices: [inheritor, anchored],
		}).filter((s) => s.lost === true);

		expect(byIdentity).toHaveLength(1);
		expect(byIdentity[0]?.id).toBe("video4");
	});
});

// ─── schema: additive, and DISTINCT from config.source ────────────────────────

describe("runtimeConfigSchema — the retention slot", () => {
	it("parses an old config that has never streamed (no last_streamed_source)", () => {
		const parsed = runtimeConfigSchema.safeParse({
			max_br: 5000,
			srt_latency: 2000,
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.last_streamed_source).toBeUndefined();
			expect(parsed.data.last_streamed_source_stable_id).toBeUndefined();
		}
	});

	it("round-trips a slot that DIFFERS from the operator's current selection", () => {
		const parsed = runtimeConfigSchema.safeParse({
			source: "/dev/video0",
			source_stable_id: "usb:hdmi",
			last_streamed_source: "/dev/video3",
			last_streamed_source_stable_id: "usb:2ca3:0023:SN-A",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.source).toBe("/dev/video0");
			expect(parsed.data.last_streamed_source).toBe("/dev/video3");
			expect(parsed.data.last_streamed_source_stable_id).toBe(
				"usb:2ca3:0023:SN-A",
			);
		}
	});
});

describe("runtimeConfigSchema — last_seen_devices additive key", () => {
	it("parses an old config with no last_seen_devices key (optional)", () => {
		const parsed = runtimeConfigSchema.safeParse({
			max_br: 5000,
			srt_latency: 2000,
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.last_seen_devices).toBeUndefined();
	});

	it("defaults to [] via RUNTIME_CONFIG_DEFAULTS", () => {
		expect(RUNTIME_CONFIG_DEFAULTS.last_seen_devices).toEqual([]);
	});

	it("round-trips a populated last_seen_devices array", () => {
		const config = {
			last_seen_devices: [
				{
					id: "video0",
					displayName: "HDMI Capture",
					kind: "hdmi",
					pipelineId: "hdmi",
					devicePath: "/dev/video0",
				},
			],
		};
		const parsed = runtimeConfigSchema.safeParse(config);
		expect(parsed.success).toBe(true);
		if (parsed.success)
			expect(parsed.data.last_seen_devices).toEqual(config.last_seen_devices);
	});

	it("rejects a snapshot missing the required devicePath", () => {
		const bad = {
			last_seen_devices: [
				{
					id: "video0",
					displayName: "HDMI Capture",
					kind: "hdmi",
					pipelineId: "hdmi",
				},
			],
		};
		expect(runtimeConfigSchema.safeParse(bad).success).toBe(false);
	});
});

// ─── the state-transition table (one test per row) ────────────────────────────

async function seedHdmiCaps(): Promise<void> {
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
						supports_audio: false,
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

describe("the state-transition table", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	afterEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	/** Make `deviceId` a live, engine-authored HDMI device and select it. */
	async function selectLiveDevice(deviceId: string): Promise<void> {
		await seedHdmiCaps();
		applyObservedEngineDevices([
			captureDevice(deviceId, "hdmi", { display_name: `Camera ${deviceId}` }),
		]);
		getConfig().source = deviceId;
	}

	/** One orchestrator whose launch outcome the caller decides. */
	function orchestratorWithCommitSpy(commits: string[]) {
		return createStreamSessionOrchestrator({
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
			// The production hook, plus a record of when it fired — so these tests
			// assert the real write, never a stand-in for it.
			onStreamCommitted: () => {
				commits.push(getConfig().source ?? "");
				noteStreamedSourceCommitted();
			},
		});
	}

	it("SAVE-ONLY config change → the slot is UNCHANGED while config.source moves", async () => {
		await selectLiveDevice("video0");
		noteStreamedSourceCommitted();
		expect(getConfig().last_streamed_source).toBe("video0");

		// A save-only edit rewrites the operator's selection and nothing else.
		getConfig().source = "video1";
		expect(getConfig().last_streamed_source).toBe("video0");
	});

	it("a start that FAILS the outcome gate → the slot is UNCHANGED (the hook never fires)", async () => {
		await selectLiveDevice("video0");
		const commits: string[] = [];
		const orchestrator = orchestratorWithCommitSpy(commits);

		const result = await orchestrator.start({
			origin: "ui",
			launch: async ({ attemptId }) => {
				// Exactly what an expired `playing-wait` phase throws: the graph may
				// well have reached PLAYING, but the engine never confirmed a really
				// streaming session, so the launch never resolves.
				throw new StreamStartFailure({
					attemptId,
					phase: "playing-wait",
					class: "start_timeout",
					retriable: false,
				});
			},
		});

		expect(result.result).toBe("failed");
		expect(commits).toEqual([]);
		expect(getConfig().last_streamed_source).toBeUndefined();
	});

	it("a start that SATISFIES the outcome gate → the slot MOVES to that configuration's device", async () => {
		await selectLiveDevice("video0");
		const commits: string[] = [];
		const orchestrator = orchestratorWithCommitSpy(commits);

		const result = await orchestrator.start({
			origin: "ui",
			launch: async () => {},
		});

		expect(result.result).toBe("started");
		expect(commits).toEqual(["video0"]);
	});

	it("the slot records the STABLE IDENTITY of the committed device, not just its node path", async () => {
		await seedHdmiCaps();
		applyObservedEngineDevices([
			captureDevice("video3", "hdmi", { stable_id: "usb:2ca3:0023:SN-A" }),
		]);
		getConfig().source = "video3";

		expect(noteStreamedSourceCommitted()).toBe(true);
		expect(getConfig().last_streamed_source).toBe("video3");
		expect(getConfig().last_streamed_source_stable_id).toBe(
			"usb:2ca3:0023:SN-A",
		);
	});

	it("a committed start on a NON-camera source SUPERSEDES the remembered camera", async () => {
		await seedHdmiCaps();
		applyObservedEngineDevices([
			captureDevice("video3", "hdmi", { stable_id: "usb:2ca3:0023:SN-A" }),
		]);
		getConfig().source = "video3";
		noteStreamedSourceCommitted();
		applyObservedEngineDevices([]);
		expect(
			getSourcesMessage().sources.find((s) => s.id === "video3")?.lost,
		).toBe(true);

		// The operator switches to the network ingest and goes live with it.
		getConfig().source = "rtmp";
		expect(noteStreamedSourceCommitted()).toBe(true);
		expect(getConfig().last_streamed_source).toBe("rtmp");
		expect(getConfig().last_streamed_source_stable_id).toBeUndefined();
		expect(getSourcesMessage().sources.some((s) => s.id === "video3")).toBe(
			false,
		);
	});

	it("STOP → the slot is UNCHANGED (only a start ever moves it)", async () => {
		await selectLiveDevice("video0");
		const commits: string[] = [];
		const orchestrator = orchestratorWithCommitSpy(commits);
		await orchestrator.start({ origin: "ui", launch: async () => {} });
		expect(commits).toHaveLength(1);

		const stopped = await orchestrator.stop("operator");
		expect(stopped.result).toBe("stopped");
		expect(commits).toHaveLength(1);
		expect(getConfig().last_streamed_source).toBe("video0");
	});

	it("a device RENUMBER → the slot follows the stable identity, not the node path", async () => {
		await seedHdmiCaps();
		getConfig().last_streamed_source = "video1";
		getConfig().last_streamed_source_stable_id = "usb:2ca3:0023:SN-A";
		getConfig().last_seen_devices = [
			lastSeen("video7", "hdmi", "hdmi", {
				displayName: "DJI Osmo Pocket 3",
				stableId: "usb:2ca3:0023:SN-A",
				previousIds: ["video1"],
			}),
		];

		// Absent under its CURRENT node path — the slot still names the old one.
		const lost = getSourcesMessage().sources.filter((s) => s.lost === true);
		expect(lost).toHaveLength(1);
		expect(lost[0]?.id).toBe("video7");
	});

	it("a restoration re-commit of the SAME configuration NEVER moves the slot (and writes nothing)", async () => {
		await selectLiveDevice("video0");
		expect(noteStreamedSourceCommitted()).toBe(true);
		const after = getConfig().last_streamed_source;

		// A restoration re-runs the configuration that was already live, so there is
		// nothing to move; the false return is the "no config write" guarantee.
		expect(noteStreamedSourceCommitted()).toBe(false);
		expect(noteStreamedSourceCommitted()).toBe(false);
		expect(getConfig().last_streamed_source).toBe(after);
	});

	it("a REPLUG while physically present is always listed — presence beats retention", async () => {
		await seedHdmiCaps();
		getConfig().last_streamed_source = "video0";
		getConfig().last_seen_devices = [lastSeen("video0", "hdmi", "hdmi")];

		applyObservedEngineDevices([]);
		expect(
			getSourcesMessage().sources.find((s) => s.id === "video0")?.lost,
		).toBe(true);

		applyObservedEngineDevices([captureDevice("video0", "hdmi")]);
		const back = getSourcesMessage().sources.find((s) => s.id === "video0");
		expect(back?.lost).toBeUndefined();
		expect(back?.available).toBe(true);
	});

	it("a BACKEND RESTART restores the slot from config, not from anything in memory", async () => {
		await seedHdmiCaps();
		getConfig().last_streamed_source = "video0";
		getConfig().last_seen_devices = [
			lastSeen("video0", "hdmi", "hdmi", { displayName: "Studio HDMI" }),
		];

		// resetEngineDeviceCache() is the restart simulation: every in-memory
		// device memory is dropped and only config.json survives.
		resetEngineDeviceCache();
		expect(getSessionSeenDeviceSnapshots().size).toBe(0);
		expect(getEngineDeviceCache()).toHaveLength(0);

		const restored = getSourcesMessage().sources.find((s) => s.id === "video0");
		expect(restored?.lost).toBe(true);
		if (restored?.origin === "capture")
			expect(restored.displayName).toBe("Studio HDMI");
	});

	it("NEGATIVE CONTROL — a 2-second blip on a never-streamed device never makes it unpickable", async () => {
		await seedHdmiCaps();
		getConfig().last_streamed_source = "video0";
		getConfig().last_seen_devices = [lastSeen("video0", "hdmi", "hdmi")];
		applyObservedEngineDevices([
			captureDevice("video0", "hdmi"),
			captureDevice("video1", "hdmi", { display_name: "Borrowed Cam" }),
		]);
		expect(
			getSourcesMessage().sources.find((s) => s.id === "video1")?.available,
		).toBe(true);

		// The blip: gone for one observation. It is not the remembered device, so it
		// leaves the list entirely rather than lingering as an unusable row.
		applyObservedEngineDevices([captureDevice("video0", "hdmi")]);
		expect(getSourcesMessage().sources.some((s) => s.id === "video1")).toBe(
			false,
		);

		// …and it is a fully selectable row again the moment it is back.
		applyObservedEngineDevices([
			captureDevice("video0", "hdmi"),
			captureDevice("video1", "hdmi", { display_name: "Borrowed Cam" }),
		]);
		const back = getSourcesMessage().sources.find((s) => s.id === "video1");
		expect(back?.available).toBe(true);
		expect(back?.lost).toBeUndefined();
	});
});

// ─── recording + persistence + LRU integration ────────────────────────────────

describe("session recording + persisted LRU (integration)", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
		clearRetentionConfig();
	});

	afterEach(() => {
		resetEngineDeviceCache();
		clearRetentionConfig();
	});

	it("an empty list-devices result does NOT clear the remembered slot's row (survives a zero-device blip)", async () => {
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({ devices: [engineDevice("video0")] }),
		});
		getConfig().last_streamed_source = "video0";

		// engine restart briefly reports zero devices (a reachable, empty list).
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({ devices: [] }),
		});
		expect(getEngineDeviceCache()).toHaveLength(0);

		const sources = buildSources({
			sources: goldenCapSources(),
			devices: getEngineDeviceCache(),
			networkIngest: NO_INGEST,
			lastStreamedSource: "video0",
			lastSeenDevices: getConfig().last_seen_devices ?? [],
		});
		expect(sources.find((s) => s.id === "video0")?.lost).toBe(true);
	});

	it("LRU churn of 14 other devices never evicts the configured id's snapshot", async () => {
		getConfig().source = "video0";
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({ devices: [engineDevice("video0")] }),
		});
		for (let i = 1; i <= 14; i++) {
			await refreshEngineDeviceCache({
				fetchEngineDevices: async () => ({
					devices: [engineDevice(`churn${i}`)],
				}),
			});
		}

		const persisted = getConfig().last_seen_devices ?? [];
		expect(persisted).toHaveLength(12);
		expect(persisted.some((d) => d.id === "video0")).toBe(true);
		// the uncapped session record keeps ALL 15 observed ids.
		expect(getSessionSeenDeviceSnapshots().size).toBe(15);
	});

	it("LRU churn never evicts the LAST-STREAMED snapshot either, even once the selection has moved on", async () => {
		// The two exemptions come apart exactly here: a save-only edit left
		// `config.source` on a different device, so only the second one protects
		// the snapshot the retention slot is rendered from.
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({
				devices: [engineDevice("video0", "Streamed Cam")],
			}),
		});
		getConfig().last_streamed_source = "video0";
		getConfig().source = "churn1";
		for (let i = 1; i <= 14; i++) {
			await refreshEngineDeviceCache({
				fetchEngineDevices: async () => ({
					devices: [engineDevice(`churn${i}`)],
				}),
			});
		}

		const persisted = getConfig().last_seen_devices ?? [];
		expect(persisted).toHaveLength(12);
		expect(persisted.some((d) => d.id === "video0")).toBe(true);

		const lost = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastStreamedSource: "video0",
			lastSeenDevices: persisted,
		}).filter((s) => s.lost === true);
		expect(lost).toHaveLength(1);
		expect(lost[0]?.id).toBe("video0");
	});

	it("a churned-out device that was never streamed keeps NO row, in-session or otherwise", async () => {
		getConfig().source = "video-config";
		getConfig().last_streamed_source = "video-config";
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({
				devices: [engineDevice("video-config")],
			}),
		});
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({
				devices: [engineDevice("videoX", "Roaming Cam")],
			}),
		});
		for (let i = 1; i <= 13; i++) {
			await refreshEngineDeviceCache({
				fetchEngineDevices: async () => ({
					devices: [engineDevice(`churn${i}`)],
				}),
			});
		}

		const persisted = getConfig().last_seen_devices ?? [];
		expect(persisted.some((d) => d.id === "videoX")).toBe(false);
		// The session record still holds it — invisible, for identity migration.
		expect(getSessionSeenDeviceSnapshots().has("videoX")).toBe(true);

		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			lastStreamedSource: getConfig().last_streamed_source,
			lastSeenDevices: persisted,
		});
		expect(sources.some((s) => s.id === "videoX")).toBe(false);
		expect(sources.find((s) => s.id === "video-config")?.lost).toBe(true);
	});

	it("the persisted retired-path memory is still capped at 8", async () => {
		const stableId = "usb:2ca3:0023:SN-A";
		for (let i = 0; i <= 12; i++) {
			await refreshEngineDeviceCache({
				fetchEngineDevices: async () => ({
					devices: [
						{
							input_id: `video${i}`,
							device_path: `/dev/video${i}`,
							display_name: "DJI Osmo Pocket 3",
							media_class: "video",
							kind: "hdmi",
							stable_id: stableId,
						},
					],
				}),
			});
		}

		const persisted = getConfig().last_seen_devices ?? [];
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.previousIds?.length).toBe(8);
	});
});

// ─── registry-driven combined transition (no second fetch) ────────────────────

function recordingClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

describe("applyObservedDevicesAndBroadcast — combined hotplug transition", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	afterEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	it("a device removed via the observed list rebroadcasts BOTH devices and sources, sources carrying the lost row — no second fetch", async () => {
		await seedHdmiCaps();
		getConfig().source = "video0";
		getConfig().last_streamed_source = "video0";
		// The registry first observed the device present (records the snapshot).
		applyObservedEngineDevices([
			captureDevice("video0", "hdmi", { display_name: "Studio HDMI" }),
		]);
		expect(getEngineDeviceCache()).toHaveLength(1);

		const sink: string[] = [];
		const client = recordingClient(sink);
		addClient(client);
		try {
			// The registry now observes the removal and hands the SAME list over —
			// there is no second list-devices fetch, so a stale/throwing re-fetch
			// (which would still show video0) can never mask the removal.
			applyObservedDevicesAndBroadcast([]);
		} finally {
			removeClient(client);
		}

		const frames = sink.map(
			(raw) => JSON.parse(raw) as Record<string, unknown>,
		);

		// BOTH broadcasts fired from the one observed list.
		const devicesFrame = frames.find((f) => "devices" in f);
		expect(devicesFrame).toBeDefined();
		const devicesPayload = devicesFrame?.devices as {
			devices: unknown[];
		};
		expect(devicesPayload.devices).toHaveLength(0);

		const sourcesFrame = frames.find((f) => "sources" in f);
		expect(sourcesFrame).toBeDefined();
		const sourcesList = (
			sourcesFrame?.sources as {
				sources: Array<Record<string, unknown>>;
			}
		).sources;
		const video0 = sourcesList.find((s) => s.id === "video0");
		expect(video0?.lost).toBe(true);
		expect(video0?.available).toBe(false);
		expect(video0?.displayName).toBe("Studio HDMI");

		// the engine-device cache reflects the observed (empty) list, NOT a stale one.
		expect(getEngineDeviceCache()).toHaveLength(0);
		// getSourcesMessage rebuilt from module state agrees (single source of truth).
		const rebuilt = getSourcesMessage().sources.find((s) => s.id === "video0");
		expect(rebuilt?.lost).toBe(true);
	});
});

// ─── hotplug rebuild: the engine probe never gets to mask an observed removal ──

describe("refreshSourcesForHotplug — a failing engine probe never masks a removal", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	afterEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	async function seedPresentDevice(): Promise<void> {
		await seedHdmiCaps();
		getConfig().source = "video0";
		getConfig().last_streamed_source = "video0";
		applyObservedEngineDevices([
			captureDevice("video0", "hdmi", { display_name: "Studio HDMI" }),
		]);
		expect(getEngineDeviceCache()).toHaveLength(1);
	}

	function captureBroadcast(
		run: () => void | Promise<void>,
	): Promise<Array<Record<string, unknown>>> {
		const sink: string[] = [];
		const client = recordingClient(sink);
		addClient(client);
		return Promise.resolve(run())
			.finally(() => removeClient(client))
			.then(() =>
				sink.map((raw) => JSON.parse(raw) as Record<string, unknown>),
			);
	}

	it("a removal seen by the local scan still reaches the sources broadcast when the engine list-devices probe throws", async () => {
		await seedPresentDevice();

		const frames = await captureBroadcast(() =>
			// The registry observed the device gone; the second engine round-trip is
			// down (mid-restart / socket refused) — exactly the live-board case where
			// the unplugged device kept rendering as available.
			refreshSourcesForHotplug([], {
				fetchEngineDevices: async () => {
					throw new Error("engine unavailable");
				},
			}),
		);

		const sourcesFrame = frames.find((f) => "sources" in f);
		expect(sourcesFrame).toBeDefined();
		const video0 = (
			sourcesFrame?.sources as { sources: Array<Record<string, unknown>> }
		).sources.find((s) => s.id === "video0");
		expect(video0?.lost).toBe(true);
		expect(video0?.available).toBe(false);

		// the cache followed the observation, not the retained pre-removal list.
		expect(getEngineDeviceCache()).toHaveLength(0);
	});

	it("a reachable engine still wins: its typed device list replaces the local observation", async () => {
		await seedPresentDevice();

		await refreshSourcesForHotplug(
			[captureDevice("video0", "usb", { display_name: "Local Scan Name" })],
			{
				fetchEngineDevices: async () => ({
					devices: [engineDevice("video0", "Engine HDMI")],
				}),
			},
		);

		const cached = getEngineDeviceCache();
		expect(cached).toHaveLength(1);
		expect(cached[0]?.display_name).toBe("Engine HDMI");
		// the engine's typed kind survives — the local scan's heuristic never lands.
		expect(cached[0]?.kind).toBe("hdmi");
	});

	it("the plain refresh keeps its retain-on-failure contract (a transient outage must not erase the last-known list)", async () => {
		await seedPresentDevice();

		await refreshAndBroadcastSources({
			fetchEngineDevices: async () => {
				throw new Error("engine unavailable");
			},
		});

		// Deliberate and unchanged: with no independent observation to trust, the
		// last-known list is better than an empty one. That is precisely why the
		// hotplug path must feed its own observation in instead of re-fetching.
		expect(getEngineDeviceCache()).toHaveLength(1);
	});
});

// ─── hotplug rebuild: a SUCCEEDING but stale probe never masks the observation ─

describe("refreshSourcesForHotplug — a stale successful probe never masks the observed set", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	afterEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	function captureBroadcast(
		run: () => void | Promise<void>,
	): Promise<Array<Record<string, unknown>>> {
		const sink: string[] = [];
		const client = recordingClient(sink);
		addClient(client);
		return Promise.resolve(run())
			.finally(() => removeClient(client))
			.then(() =>
				sink.map((raw) => JSON.parse(raw) as Record<string, unknown>),
			);
	}

	function sourceRow(
		frames: Array<Record<string, unknown>>,
		id: string,
	): Record<string, unknown> | undefined {
		const frame = frames.find((f) => "sources" in f);
		expect(frame).toBeDefined();
		return (
			frame?.sources as { sources: Array<Record<string, unknown>> }
		).sources.find((s) => s.id === id);
	}

	/** The device was streamed, then unplugged — so it currently renders `lost`. */
	async function seedLostDevice(): Promise<void> {
		await seedHdmiCaps();
		getConfig().source = "video0";
		getConfig().last_streamed_source = "video0";
		applyObservedEngineDevices([
			captureDevice("video0", "hdmi", { display_name: "Studio HDMI" }),
		]);
		applyObservedEngineDevices([]);
		expect(
			getSourcesMessage().sources.find((s) => s.id === "video0")?.lost,
		).toBe(true);
	}

	it("a replug the local scan observed is NOT hidden by a probe that answers with a stale empty list", async () => {
		await seedLostDevice();

		const frames = await captureBroadcast(() =>
			// The RØDE replug: the registry's own scan already proved the node is
			// back, but the engine probe answers BEFORE the OS finished re-
			// enumerating the USB device, so it truthfully reports "no devices".
			refreshSourcesForHotplug(
				[captureDevice("video0", "hdmi", { display_name: "Studio HDMI" })],
				{ fetchEngineDevices: async () => ({ devices: [] }) },
			),
		);

		const video0 = sourceRow(frames, "video0");
		expect(video0?.lost).toBeUndefined();
		expect(video0?.available).toBe(true);
		expect(getEngineDeviceCache().map((d) => d.input_id)).toEqual(["video0"]);
	});

	it("a removal the local scan observed is NOT resurrected by a probe still answering with the pre-removal list", async () => {
		await seedHdmiCaps();
		getConfig().source = "video0";
		getConfig().last_streamed_source = "video0";
		applyObservedEngineDevices([
			captureDevice("video0", "hdmi", { display_name: "Studio HDMI" }),
		]);

		const frames = await captureBroadcast(() =>
			refreshSourcesForHotplug([], {
				fetchEngineDevices: async () => ({
					devices: [engineDevice("video0", "Studio HDMI")],
				}),
			}),
		);

		const video0 = sourceRow(frames, "video0");
		expect(video0?.lost).toBe(true);
		expect(video0?.available).toBe(false);
		expect(getEngineDeviceCache()).toHaveLength(0);
	});

	it("the probe still supplies the richer metadata for every device the observation confirms", async () => {
		await seedHdmiCaps();

		await refreshSourcesForHotplug(
			[
				captureDevice("video0", "usb", { display_name: "Local Scan Name" }),
				captureDevice("video1", "usb", {
					display_name: "Only The Scan Saw It",
				}),
			],
			{
				fetchEngineDevices: async () => ({
					devices: [engineDevice("video0", "Engine HDMI")],
				}),
			},
		);

		const cached = getEngineDeviceCache();
		expect(cached.map((d) => d.input_id)).toEqual(["video0", "video1"]);
		expect(cached[0]?.display_name).toBe("Engine HDMI");
		expect(cached[0]?.kind).toBe("hdmi");
		expect(cached[1]?.display_name).toBe("Only The Scan Saw It");
		expect(cached[1]?.kind).toBe("usb");
	});

	it("keeps refreshing the audio-naming cache, which only the engine can populate", async () => {
		await seedHdmiCaps();

		await refreshSourcesForHotplug(
			[
				captureDevice("video0", "hdmi", { display_name: "Studio HDMI" }),
				// The local scan names audio in CeraUI's own namespace, which shares
				// no ids with the engine's — so it is not comparable, and merging it
				// in would duplicate the card under a second identity.
				captureDevice("audio:usbaudio", "audio", {
					device_path: "alsa:usbaudio",
					media_class: "audio",
				}),
			],
			{
				fetchEngineDevices: async () => ({
					devices: [
						engineDevice("video0", "Studio HDMI"),
						{
							input_id: "audio:card0",
							device_path: "alsa:card0",
							display_name: "RØDE HDMI to USB-C",
							media_class: "audio",
							kind: "audio",
							alsa_card_id: "Device",
						} as ListDevicesResult["devices"][number],
					],
				}),
			},
		);

		const audio = getEngineAudioDevices();
		expect(audio).toHaveLength(1);
		expect(audio[0]?.alsa_card_id).toBe("Device");
		// The observation carries no engine audio rows, so it must not evict them.
		expect(getEngineDeviceCache().map((d) => d.input_id)).toEqual([
			"video0",
			"audio:card0",
		]);
	});

	it("re-resolves the audio surface when the engine audio list CHANGES, and only then", async () => {
		// Found live: `audio.ts` caches the resolved label/identity maps and rebuilds
		// them only inside `updateAudioDevices()` (udev SIGUSR2 / boot). The engine's
		// own audio enumeration lands later, through this path — so a card plugged
		// mid-session kept rendering with no `transport`/`stable_id` for the rest of
		// the session even though the engine had reported both within seconds.
		let reresolves = 0;
		setEngineAudioChangeHandler(() => {
			reresolves++;
		});
		try {
			await seedHdmiCaps();
			const observed = [
				captureDevice("video0", "hdmi", { display_name: "Studio HDMI" }),
			];
			const withCards = (cards: string[]) => ({
				fetchEngineDevices: async () => ({
					devices: [
						engineDevice("video0", "Studio HDMI"),
						...cards.map(
							(card) =>
								({
									input_id: `audio:${card}`,
									device_path: `alsa:${card}`,
									display_name: card,
									media_class: "audio",
									kind: "audio",
									alsa_card_id: card,
								}) as ListDevicesResult["devices"][number],
						),
					],
				}),
			});

			await refreshSourcesForHotplug(observed, withCards(["usbaudio"]));
			expect(reresolves).toBe(1);

			// The steady state of the 5 s signal recheck: identical list, no work.
			await refreshSourcesForHotplug(observed, withCards(["usbaudio"]));
			expect(reresolves).toBe(1);

			// A card appears — exactly the DJI-plugged-mid-session case.
			await refreshSourcesForHotplug(
				observed,
				withCards(["usbaudio", "DJIPocket3"]),
			);
			expect(reresolves).toBe(2);
			expect(getEngineAudioDevices().map((d) => d.alsa_card_id)).toEqual([
				"usbaudio",
				"DJIPocket3",
			]);

			await refreshSourcesForHotplug(observed, withCards(["usbaudio"]));
			expect(reresolves).toBe(3);
		} finally {
			setEngineAudioChangeHandler(undefined);
		}
	});

	it("an OLDER hotplug refresh answering late never clobbers a NEWER one's result", async () => {
		await seedHdmiCaps();
		getConfig().source = "video0";
		getConfig().last_streamed_source = "video0";
		applyObservedEngineDevices([
			captureDevice("video0", "hdmi", { display_name: "Studio HDMI" }),
		]);

		// The unplug fires first, but its engine probe hangs.
		let releaseStaleProbe: (result: ListDevicesResult) => void = () => {};
		const staleProbe = new Promise<ListDevicesResult>((resolve) => {
			releaseStaleProbe = resolve;
		});
		const older = refreshSourcesForHotplug([], {
			fetchEngineDevices: () => staleProbe,
		});

		await refreshSourcesForHotplug(
			[captureDevice("video0", "hdmi", { display_name: "Studio HDMI" })],
			{
				fetchEngineDevices: async () => ({
					devices: [engineDevice("video0", "Studio HDMI")],
				}),
			},
		);
		expect(getEngineDeviceCache()).toHaveLength(1);

		// Only NOW does the removal's probe answer — with the world as it was.
		const frames = await captureBroadcast(() => {
			releaseStaleProbe({ devices: [] });
			return older;
		});

		expect(frames.some((f) => "sources" in f)).toBe(false);
		expect(getEngineDeviceCache().map((d) => d.input_id)).toEqual(["video0"]);
		expect(
			getSourcesMessage().sources.find((s) => s.id === "video0")?.lost,
		).toBeUndefined();
	});

	it("an OLDER refresh whose probe FAILS late does not fall back over a NEWER result", async () => {
		await seedHdmiCaps();
		getConfig().source = "video0";
		getConfig().last_streamed_source = "video0";
		applyObservedEngineDevices([
			captureDevice("video0", "hdmi", { display_name: "Studio HDMI" }),
		]);

		let failStaleProbe: (err: Error) => void = () => {};
		const staleProbe = new Promise<ListDevicesResult>((_resolve, reject) => {
			failStaleProbe = reject;
		});
		const older = refreshSourcesForHotplug([], {
			fetchEngineDevices: () => staleProbe,
		});

		await refreshSourcesForHotplug(
			[captureDevice("video0", "hdmi", { display_name: "Studio HDMI" })],
			{
				fetchEngineDevices: async () => ({
					devices: [engineDevice("video0", "Studio HDMI")],
				}),
			},
		);

		failStaleProbe(new Error("engine unavailable"));
		await older;

		// The observed-fallback is still correct — it just belongs to the generation
		// that owns the current view, not to a superseded one.
		expect(getEngineDeviceCache().map((d) => d.input_id)).toEqual(["video0"]);
	});
});

// ─── replug: a probe that cannot speak for the device must not DEGRADE it ─────
//
// The live RØDE reconnect regression. The local scan can only guess a kind from
// the card name (`deriveKind`), and for a UVC dongle the guess is `usb` — which
// bridges to NO pipeline, so `buildSources` drops the row entirely and the coarse
// `usb_mjpeg` slot renders "USB MJPEG / not connected" instead. It is permanent
// because nothing re-pokes a stable device set.

describe("refreshSourcesForHotplug — a replug the probe has not caught up with keeps its engine identity", () => {
	// Byte-exact strings from the bug hardware (Rock 5B+). The v4l2 card name
	// (`/sys/class/video4linux/video1/name`) and the engine's `display_name` are
	// the SAME kernel string — that is what makes the name a sound identity gate.
	const RODE_NAME = "RØDE HDMI to USB-C: RØDE HDMI";
	const RODE_STABLE_ID = "usb:19f7:0080:RØDE_RØDE_HDMI_to_USB-C_OC0001967";

	beforeEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	afterEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		clearRetentionConfig();
	});

	function engineHdmiRx(): ListDevicesResult["devices"][number] {
		return {
			input_id: "/dev/video0",
			device_path: "/dev/video0",
			display_name: "rk_hdmirx",
			media_class: "video",
			kind: "hdmi",
		};
	}

	function engineRode(): ListDevicesResult["devices"][number] {
		return {
			input_id: "/dev/video1",
			device_path: "/dev/video1",
			display_name: RODE_NAME,
			media_class: "video",
			kind: "mjpeg",
			stable_id: RODE_STABLE_ID,
			caps: [
				{
					media_type: "video/x-raw",
					width: 1920,
					height: 1080,
					framerate: "30/1",
				},
			],
		};
	}

	// What the v4l2 fallback scan sees: real card names, GUESSED kinds.
	function scannedHdmiRx(): CaptureDevice {
		return captureDevice("/dev/video0", "hdmi", {
			device_path: "/dev/video0",
			display_name: "stream_hdmirx",
		});
	}
	function scannedRode(): CaptureDevice {
		return captureDevice("/dev/video1", "usb", {
			device_path: "/dev/video1",
			display_name: RODE_NAME,
		});
	}

	async function seedHdmiAndMjpegCaps(): Promise<void> {
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
					sources: [capSource("hdmi"), capSource("usb_mjpeg")],
				},
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
		});
	}

	async function seedThenUnplugRode(): Promise<void> {
		await seedHdmiAndMjpegCaps();
		getConfig().source = "/dev/video1";
		getConfig().last_streamed_source = "/dev/video1";
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({
				devices: [engineHdmiRx(), engineRode()],
			}),
		});
		await refreshSourcesForHotplug([scannedHdmiRx()], {
			fetchEngineDevices: async () => ({ devices: [engineHdmiRx()] }),
		});
		expect(
			getSourcesMessage().sources.find((s) => s.id === "/dev/video1")?.lost,
		).toBe(true);
	}

	it("a replugged device the probe still omits keeps its engine kind, name and stable id — never a coarse 'not connected' row", async () => {
		await seedThenUnplugRode();

		// The node is back and the scan proves it, but the engine's list-devices
		// has not caught up with the re-enumeration yet.
		await refreshSourcesForHotplug([scannedHdmiRx(), scannedRode()], {
			fetchEngineDevices: async () => ({ devices: [engineHdmiRx()] }),
		});

		const sources = getSourcesMessage().sources;
		const rode = sources.find((s) => s.id === "/dev/video1");
		expect(rode?.origin).toBe("capture");
		expect(rode?.available).toBe(true);
		expect(rode?.lost).toBeUndefined();
		if (rode?.origin === "capture") {
			expect(rode.displayName).toBe(RODE_NAME);
			expect(rode.kind).toBe("mjpeg");
			expect(rode.stableId).toBe(RODE_STABLE_ID);
		}
		// the coarse slot it bridges to is REPLACED, not left rendering
		// "USB MJPEG · not connected" beside a vanished device.
		expect(
			sources.some((s) => s.origin === "coarse" && s.id === "usb_mjpeg"),
		).toBe(false);
	});

	it("the same restoration applies when the probe FAILS outright (the observed-fallback branch)", async () => {
		await seedThenUnplugRode();

		await refreshSourcesForHotplug([scannedHdmiRx(), scannedRode()], {
			fetchEngineDevices: async () => {
				throw new Error("engine unavailable");
			},
		});

		const rode = getSourcesMessage().sources.find(
			(s) => s.id === "/dev/video1",
		);
		expect(rode?.origin).toBe("capture");
		expect(rode?.available).toBe(true);
		if (rode?.origin === "capture") expect(rode.kind).toBe("mjpeg");
	});

	it("a DIFFERENT device recycling the same node path is never given the old identity", async () => {
		await seedThenUnplugRode();

		// The kernel handed /dev/video1 to something else entirely.
		await refreshSourcesForHotplug(
			[
				scannedHdmiRx(),
				captureDevice("/dev/video1", "usb", {
					device_path: "/dev/video1",
					display_name: "Generic USB Camera",
				}),
			],
			{ fetchEngineDevices: async () => ({ devices: [engineHdmiRx()] }) },
		);

		const cached = getEngineDeviceCache().find(
			(d) => d.input_id === "/dev/video1",
		);
		expect(cached?.display_name).toBe("Generic USB Camera");
		expect(cached?.kind).toBe("usb");
		expect(cached?.stable_id).toBeUndefined();
	});

	it("a live probe entry still wins outright over the remembered one", async () => {
		await seedThenUnplugRode();

		await refreshSourcesForHotplug([scannedHdmiRx(), scannedRode()], {
			fetchEngineDevices: async () => ({
				devices: [
					engineHdmiRx(),
					{ ...engineRode(), display_name: "RØDE (renamed by the engine)" },
				],
			}),
		});

		const cached = getEngineDeviceCache().find(
			(d) => d.input_id === "/dev/video1",
		);
		expect(cached?.display_name).toBe("RØDE (renamed by the engine)");
	});

	it("mergeObservedWithProbe restores only from the map it is handed (pure)", () => {
		const remembered = new Map<string, CaptureDevice>([
			[
				"/dev/video1",
				captureDevice("/dev/video1", "mjpeg", {
					device_path: "/dev/video1",
					display_name: RODE_NAME,
				}),
			],
		]);
		const merged = mergeObservedWithProbe(
			[scannedRode()],
			[],
			remembered,
		) as CaptureDevice[];
		expect(merged.map((d) => d.kind)).toEqual(["mjpeg"]);

		// with no memory to draw on, the observation passes through untouched.
		expect(
			mergeObservedWithProbe([scannedRode()], [], new Map()).map((d) => d.kind),
		).toEqual(["usb"]);
	});
});
