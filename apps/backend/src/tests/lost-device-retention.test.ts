/*
 * C7 — lost-device retention + persisted last-seen metadata (Todo 11).
 *
 * `buildSources` synthesizes a `lost` capture row for a remembered device absent
 * from the current engine list: one seen THIS session (uncapped in-memory session
 * map), or the CONFIGURED device across a restart (persisted, capped,
 * config.source-exempt LRU). The lost row REPLACES its coarse base slot, so a
 * remembered input is EXACTLY one row — never a coarse+lost duplicate. A device
 * neither configured nor session-seen synthesizes NOTHING (no zombie list growth).
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
	getEngineDeviceCache,
	getSessionSeenDeviceSnapshots,
	getSourcesMessage,
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
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
	};
}

function sessionMap(
	...snapshots: LastSeenDevice[]
): Map<string, LastSeenDevice> {
	return new Map(snapshots.map((s) => [s.id, s]));
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

// ─── (1) unplug: exactly one lost row, no coarse duplicate ────────────────────

describe("buildSources — lost-device synthesis (pure)", () => {
	it("(1) unplug of the configured device → EXACTLY one row (lost, unavailable, named from snapshot), no coarse duplicate", () => {
		const snapshot = lastSeen("video0", "hdmi", "hdmi", {
			displayName: "Magewell HDMI Capture",
		});
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			configSource: "video0",
			lastSeenDevices: [snapshot],
			sessionSnapshots: sessionMap(snapshot),
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
		// the other coarse entries are untouched.
		expect(
			sources.filter((s) => s.origin === "coarse").map((s) => s.id),
		).toEqual(["usb_mjpeg", "v4l_mjpeg", "camlink", "libuvch264"]);
	});

	it("(2) replug → the lost row is replaced by the live row in one rebuild", () => {
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
			configSource: "video0",
			lastSeenDevices: [snapshot],
			sessionSnapshots: sessionMap(snapshot),
		});

		const rows = sources.filter((s) => s.id === "video0");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.origin).toBe("capture");
		expect(rows[0]?.available).toBe(true);
		expect(rows[0]?.lost).toBeUndefined();
	});

	it("(3) restart: only the CONFIGURED id's last_seen entry becomes a lost row (session map empty)", () => {
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			configSource: "video0",
			lastSeenDevices: [
				lastSeen("video0", "hdmi", "hdmi", { displayName: "Configured HDMI" }),
				lastSeen("video1", "hdmi", "hdmi", { displayName: "Other HDMI" }),
			],
			sessionSnapshots: sessionMap(),
		});

		const video0 = sources.find((s) => s.id === "video0");
		expect(video0?.lost).toBe(true);
		if (video0?.origin === "capture")
			expect(video0.displayName).toBe("Configured HDMI");
		// the non-configured last_seen entry does NOT synthesize a row across a restart.
		expect(sources.some((s) => s.id === "video1")).toBe(false);
	});

	it("(5) session-seen non-configured device → lost row present; after restart (session reset) → NO lost row", () => {
		const seen = lastSeen("video2", "hdmi", "hdmi", {
			displayName: "Session Cam",
		});
		// A: seen this session, NOT config.source, then detached.
		const inSession = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			configSource: "video0",
			lastSeenDevices: [seen],
			sessionSnapshots: sessionMap(seen),
		});
		const sessionRow = inSession.find((s) => s.id === "video2");
		expect(sessionRow?.lost).toBe(true);

		// B: simulated restart — session map reset, video2 NOT the configured id.
		const afterRestart = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			configSource: "video0",
			lastSeenDevices: [seen],
			sessionSnapshots: sessionMap(),
		});
		expect(afterRestart.some((s) => s.id === "video2")).toBe(false);
	});

	it("(8) a snapshot whose pipelineId is absent from the current coarse set synthesizes NO row", () => {
		const snapshot = lastSeen("video0", "hdmi", "hdmi");
		const sources = buildSources({
			// hdmi is NOT offered this build (caps changed), so nothing bridges to it.
			sources: [capSource("usb_mjpeg"), capSource("test")],
			devices: [],
			networkIngest: NO_INGEST,
			configSource: "video0",
			lastSeenDevices: [snapshot],
			sessionSnapshots: sessionMap(snapshot),
		});
		expect(sources.some((s) => s.id === "video0")).toBe(false);
		expect(sources.map((s) => s.id)).toEqual(["usb_mjpeg", "test"]);
	});

	it("(QA) device absent AND not configured AND not session-seen → NO lost row (no zombie)", () => {
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			configSource: "video0",
			// video9 is remembered ONLY in persisted last_seen, and it is NOT the
			// configured id and NOT session-seen → it must stay a zombie-free ghost.
			lastSeenDevices: [lastSeen("video9", "hdmi", "hdmi")],
			sessionSnapshots: sessionMap(),
		});
		expect(sources.some((s) => s.id === "video9")).toBe(false);
	});

	it("(11) every synthesized lost row parses under streamSourceSchema with devicePath present", () => {
		const snapshot = lastSeen("video0", "hdmi", "hdmi", {
			displayName: "Elgato Cam Link 4K",
			devicePath: "/dev/video7",
		});
		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			configSource: "video0",
			lastSeenDevices: [snapshot],
			sessionSnapshots: sessionMap(snapshot),
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
});

// ─── (4) schema: additive key, default [], required devicePath ────────────────

describe("runtimeConfigSchema — last_seen_devices additive key", () => {
	it("(4) parses an old config with no last_seen_devices key (optional)", () => {
		const parsed = runtimeConfigSchema.safeParse({
			max_br: 5000,
			srt_latency: 2000,
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.last_seen_devices).toBeUndefined();
	});

	it("(4) defaults to [] via RUNTIME_CONFIG_DEFAULTS", () => {
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

// ─── (6,7,10) recording + persistence + LRU integration ───────────────────────

describe("session recording + persisted LRU (integration)", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
	});

	afterEach(() => {
		resetEngineDeviceCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
	});

	it("(6) an empty list-devices result does NOT clear the session map (lost rows survive a zero-device blip)", async () => {
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({ devices: [engineDevice("video0")] }),
		});
		expect(getSessionSeenDeviceSnapshots().has("video0")).toBe(true);

		// engine restart briefly reports zero devices (a reachable, empty list).
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => ({ devices: [] }),
		});
		expect(getEngineDeviceCache()).toHaveLength(0);
		// the session memory is monotonic — the id is NOT dropped.
		expect(getSessionSeenDeviceSnapshots().has("video0")).toBe(true);

		const sources = buildSources({
			sources: goldenCapSources(),
			devices: getEngineDeviceCache(),
			networkIngest: NO_INGEST,
			sessionSnapshots: getSessionSeenDeviceSnapshots(),
		});
		expect(sources.find((s) => s.id === "video0")?.lost).toBe(true);
	});

	it("(7) LRU churn of 14 other devices never evicts the configured id's snapshot", async () => {
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
		// the uncapped session map keeps ALL 15 observed ids.
		expect(getSessionSeenDeviceSnapshots().size).toBe(15);
	});

	it("(10) a non-configured session-seen device evicted from the persisted LRU still synthesizes a full lost row in-session", async () => {
		getConfig().source = "video-config";
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
		// videoX was evicted from the capped persisted list…
		expect(persisted.some((d) => d.id === "videoX")).toBe(false);
		// …but survives in the uncapped session map (metadata intact).
		expect(getSessionSeenDeviceSnapshots().has("videoX")).toBe(true);

		const sources = buildSources({
			sources: goldenCapSources(),
			devices: [],
			networkIngest: NO_INGEST,
			configSource: getConfig().source,
			lastSeenDevices: persisted,
			sessionSnapshots: getSessionSeenDeviceSnapshots(),
		});
		const lost = sources.find((s) => s.id === "videoX");
		expect(lost?.lost).toBe(true);
		if (lost?.origin === "capture")
			expect(lost.displayName).toBe("Roaming Cam");
	});
});

// ─── (9) registry-driven combined transition (no second fetch) ────────────────

function recordingClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

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

describe("applyObservedDevicesAndBroadcast — combined hotplug transition (C7)", () => {
	beforeEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
	});

	afterEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
	});

	it("(9) a device removed via the observed list rebroadcasts BOTH devices and sources, sources carrying the lost row — no second fetch", async () => {
		await seedHdmiCaps();
		getConfig().source = "video0";
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
