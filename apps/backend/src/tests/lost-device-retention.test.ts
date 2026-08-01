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
	getEngineAudioDevices,
	getEngineDeviceCache,
	getSessionSeenDeviceSnapshots,
	getSourcesMessage,
	mergeObservedWithProbe,
	refreshAndBroadcastSources,
	refreshEngineDeviceCache,
	refreshSourcesForHotplug,
	resetEngineDeviceCache,
	setEngineAudioChangeHandler,
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
		// the USB-capture placeholders that used to sit beside it are suppressed
		// in every state now (todo 21a), so no coarse row survives this build.
		expect(
			sources.filter((s) => s.origin === "coarse").map((s) => s.id),
		).toEqual([]);
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
		// `usb_mjpeg` is a suppressed USB-capture placeholder, so only the virtual
		// test-pattern row remains (todo 21a).
		expect(sources.map((s) => s.id)).toEqual(["test"]);
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

// ─── hotplug rebuild: the engine probe never gets to mask an observed removal ──

describe("refreshSourcesForHotplug — a failing engine probe never masks a removal", () => {
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

	async function seedPresentDevice(): Promise<void> {
		await seedHdmiCaps();
		getConfig().source = "video0";
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
		getConfig().last_seen_devices = [];
		delete getConfig().source;
	});

	afterEach(() => {
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		getConfig().last_seen_devices = [];
		delete getConfig().source;
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

	/** The device was seen, then unplugged — so it currently renders `lost`. */
	async function seedLostDevice(): Promise<void> {
		await seedHdmiCaps();
		getConfig().source = "video0";
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

		// The PR #214 observed-fallback is still correct — it just belongs to the
		// generation that owns the current view, not to a superseded one.
		expect(getEngineDeviceCache().map((d) => d.input_id)).toEqual(["video0"]);
	});
});

// ─── replug: a probe that cannot speak for the device must not DEGRADE it ─────
//
// The live RØDE reconnect regression. #214/#215 made the replugged device stay
// PRESENT; this is about it staying ITSELF. The local scan can only guess a kind
// from the card name (`deriveKind`), and for a UVC dongle the guess is `usb` —
// which bridges to NO pipeline, so `buildSources` drops the row entirely and the
// coarse `usb_mjpeg` slot renders "USB MJPEG / not connected" instead. It is
// permanent for the same reason #215 was: nothing re-pokes a stable device set.

describe("refreshSourcesForHotplug — a replug the probe has not caught up with keeps its engine identity", () => {
	// Byte-exact strings from the bug hardware (Rock 5B+). The v4l2 card name
	// (`/sys/class/video4linux/video1/name`) and the engine's `display_name` are
	// the SAME kernel string — that is what makes the name a sound identity gate.
	const RODE_NAME = "RØDE HDMI to USB-C: RØDE HDMI";
	const RODE_STABLE_ID = "usb:19f7:0080:RØDE_RØDE_HDMI_to_USB-C_OC0001967";

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

	it("the same restoration applies when the probe FAILS outright (the #214 observed-fallback branch)", async () => {
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
