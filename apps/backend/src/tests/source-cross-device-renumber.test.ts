/*
 * W4A4-F5 — a LIVE node path is not proof of the operator's device.
 *
 * Confirmed on hardware (192.168.78.131, 2026-07-31 19:55Z) with a DJI Osmo
 * Pocket 3 and a RØDE HDMI-to-USB-C enumerated simultaneously. The operator
 * selected the RØDE at `/dev/video3`; both cameras were then dropped and brought
 * back in the OPPOSITE order, so the RØDE took `/dev/video1,2` and the **Osmo
 * took over `/dev/video3`** — the exact node the saved config names.
 *
 * `config` was untouched (`source: "/dev/video3"`, `pipeline: "usb_mjpeg"`) while
 * `/dev/video3` was now a `libuvch264` device, and a preview on the operator's
 * own configured source delivered **45 frames / 1 472 962 bytes with zero errors
 * and zero typed transitions** — a healthy-looking preview of a camera they did
 * not choose.
 *
 * The identity layer was never at fault: `stable_id` survived on both devices and
 * `last_seen_devices` migrated both rows correctly. Only the SELECTION failed to
 * follow, because `resolveSourceIdentity` short-circuited on the node path being
 * live without ever asking WHICH device now holds it:
 *
 *   if (sources.some((s) => s.id === sourceId)) return sourceId;
 *
 * And it could not be recovered retroactively: after the fold `/dev/video3` had
 * three claimants in `last_seen_devices`, so `unambiguousStableId` correctly
 * REFUSED to guess (#263). The missing piece is an anchor written at SELECTION
 * time — `config.source_stable_id`.
 *
 * These tests drive the REAL `setConfig` procedure, the REAL routing seam, the
 * REAL reconciler and the REAL preview-frame resolver against that hardware
 * topology. The regression controls (a genuine same-identity renumber, an
 * anchorless legacy config, an anchored path still held by its own device) are
 * as load-bearing as the repro: the fix must not cost the migration behaviour
 * todos 12/13 exist to protect.
 */

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
import { SCHEMA_VERSION } from "@ceralive/cerastream";
import type {
	CaptureDevice,
	DeviceKind,
	NetworkIngest,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import type { LastSeenDevice } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import * as configMigration from "../modules/streaming/config-migration.ts";
import * as sourcesModule from "../modules/streaming/sources.ts";
import { resolvePreviewStartFrame } from "../modules/ui/preview-proxy.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// `mock.module` mutates the namespace in place, so the restore in afterAll must
// come from a snapshot taken at load time (same rule as the F10 suite).
const realSources = { ...sourcesModule };
const realConfigMigration = { ...configMigration };

const SOURCES_PATH = "../modules/streaming/sources.ts";
const CONFIG_MIGRATION_PATH = "../modules/streaming/config-migration.ts";

const NO_INGEST: NetworkIngest = { rtmp: null, srt: null };

// The board's own two cameras, with their real reported identities.
const RODE_NAME = "RØDE HDMI to USB-C: RØDE HDMI";
const RODE_STABLE = "usb:19f7:0080:RØDE_RØDE_HDMI_to_USB-C_OC0001967";
const OSMO_NAME = "DJIPocket3: OsmoPocket3";
const OSMO_STABLE = "usb:2ca3:0023:DJI_DJIPocket3_123456789ABCDEF";
const HDMI_NAME = "HDMI Input";
const HDMI_STABLE = "port:fdee0000.hdmirx-controller";

function capSource(id: string) {
	return {
		id,
		supports_audio: false,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
	};
}

function goldenCapSources() {
	return ["hdmi", "usb_mjpeg", "v4l_mjpeg", "camlink", "libuvch264"].map(
		capSource,
	);
}

function captureDevice(
	input_id: string,
	kind: DeviceKind,
	overrides: Partial<CaptureDevice> = {},
): CaptureDevice {
	return {
		input_id,
		device_path: overrides.device_path ?? input_id,
		display_name: overrides.display_name ?? input_id,
		media_class: "video",
		kind,
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
		devicePath: overrides.devicePath ?? id,
		...(overrides.stableId !== undefined
			? { stableId: overrides.stableId }
			: {}),
		...(overrides.previousIds !== undefined
			? { previousIds: overrides.previousIds }
			: {}),
	};
}

function sourcesFrom(
	devices: readonly CaptureDevice[],
	configSource: string,
	lastSeenDevices: readonly LastSeenDevice[],
): StreamSource[] {
	return realSources.buildSources({
		sources: goldenCapSources(),
		devices,
		networkIngest: NO_INGEST,
		configSource,
		lastSeenDevices,
		sessionSnapshots: realSources.getSessionSeenDeviceSnapshots(),
	});
}

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

// ── Board topology, before and after the crossed renumber ───────────────────

/** PRE: the RØDE holds `/dev/video3`, the Osmo holds `/dev/video1`. */
function preDevices(): CaptureDevice[] {
	return [
		captureDevice("/dev/video3", "mjpeg", {
			display_name: RODE_NAME,
			stable_id: RODE_STABLE,
		}),
		captureDevice("/dev/video1", "uvc_h264", {
			display_name: OSMO_NAME,
			stable_id: OSMO_STABLE,
		}),
	];
}

/** POST: both came back in the opposite order — the Osmo now holds `/dev/video3`. */
function crossedDevices(): CaptureDevice[] {
	return [
		captureDevice("/dev/video1", "mjpeg", {
			display_name: RODE_NAME,
			stable_id: RODE_STABLE,
		}),
		captureDevice("/dev/video3", "uvc_h264", {
			display_name: OSMO_NAME,
			stable_id: OSMO_STABLE,
		}),
	];
}

/** POST, with the RØDE never coming back: only the Osmo holds `/dev/video3`. */
function osmoOnlyDevices(): CaptureDevice[] {
	return [
		captureDevice("/dev/video3", "uvc_h264", {
			display_name: OSMO_NAME,
			stable_id: OSMO_STABLE,
		}),
	];
}

/**
 * The board's OWN post-fold `last_seen_devices`, reproduced from the drill
 * transcript. Note `/dev/video3` has three claimants across these rows — which
 * is exactly why `unambiguousStableId` cannot recover the selection after the
 * fact, and why the anchor has to be written at selection time.
 */
function crossedSnapshots(): LastSeenDevice[] {
	return [
		lastSeen("/dev/video1", "mjpeg", "usb_mjpeg", {
			displayName: RODE_NAME,
			devicePath: "/dev/video1",
			stableId: RODE_STABLE,
			previousIds: ["/dev/video3", "/dev/video4"],
		}),
		lastSeen("/dev/video3", "uvc_h264", "libuvch264", {
			displayName: OSMO_NAME,
			devicePath: "/dev/video3",
			stableId: OSMO_STABLE,
			previousIds: ["/dev/video1", "/dev/video2"],
		}),
		lastSeen("/dev/video0", "hdmi", "hdmi", {
			displayName: HDMI_NAME,
			devicePath: "/dev/video0",
			stableId: HDMI_STABLE,
			previousIds: ["/dev/video3"],
		}),
	];
}

/** Seed the capability snapshot the REAL `getSourcesMessage()` folds against. */
async function seedCaps(): Promise<void> {
	await getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: {
				platform: {
					supports_h265: true,
					hardware_accelerated: true,
					max_resolution: "3840x2160",
				},
				encoder: {
					codecs: ["h264"],
					bitrate_range: { min: 500, max: 20000, unit: "kbps" },
				},
				sources: goldenCapSources(),
			},
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
}

function resetConfig(): void {
	const config = getConfig();
	config.source = undefined;
	config.source_stable_id = undefined;
	config.selected_video_input = undefined;
	config.last_seen_devices = [];
	realSources.resetEngineDeviceCache();
	clearCapabilitiesCache();
}

// ---------------------------------------------------------------------------
// The anchor is WRITTEN wherever the selection is persisted
// ---------------------------------------------------------------------------

describe("W4A4-F5 — the operator's selection carries an identity anchor", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	let setConfigProcedure: Awaited<
		typeof import("../rpc/procedures/streaming.procedure.ts")
	>["setConfigProcedure"];

	/** The list the procedure resolves against — swapped per test. */
	let procedureView: StreamSource[] = [];

	beforeAll(async () => {
		delete process.env.MOCK_MODE;
		process.env.NODE_ENV = "test";

		mock.module(SOURCES_PATH, () => ({
			...realSources,
			getSourcesMessage: () => ({
				hardware: "rk3588" as const,
				sources: procedureView,
			}),
		}));
		mock.module(CONFIG_MIGRATION_PATH, () => ({
			...realConfigMigration,
			validatePersistedPipeline: () => ({ valid: true }),
		}));

		const proc = await import("../rpc/procedures/streaming.procedure.ts");
		setConfigProcedure = proc.setConfigProcedure;
	});

	afterAll(() => {
		mock.module(SOURCES_PATH, () => ({ ...realSources }));
		mock.module(CONFIG_MIGRATION_PATH, () => ({ ...realConfigMigration }));
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	beforeEach(resetConfig);
	afterEach(resetConfig);

	test("setConfig persists the selected device's stable id beside its node path", async () => {
		procedureView = sourcesFrom(preDevices(), "/dev/video3", []);

		const saved = await call(
			setConfigProcedure,
			{ source: "/dev/video3" },
			{ context: makeContext() },
		);

		expect(saved.success).toBe(true);
		expect(getConfig().source).toBe("/dev/video3");
		expect(getConfig().source_stable_id).toBe(RODE_STABLE);
	});

	test("a selection with no stable identity CLEARS a stale anchor", async () => {
		// Switching from an anchored USB camera to a coarse/unidentified source
		// must not leave the previous device's anchor governing the new pick.
		procedureView = sourcesFrom(preDevices(), "/dev/video3", []);
		await call(
			setConfigProcedure,
			{ source: "/dev/video3" },
			{ context: makeContext() },
		);
		expect(getConfig().source_stable_id).toBe(RODE_STABLE);

		procedureView = sourcesFrom(
			[captureDevice("/dev/video0", "hdmi", { display_name: HDMI_NAME })],
			"/dev/video0",
			[],
		);
		const saved = await call(
			setConfigProcedure,
			{ source: "/dev/video0" },
			{ context: makeContext() },
		);

		expect(saved.success).toBe(true);
		expect(getConfig().source).toBe("/dev/video0");
		expect(getConfig().source_stable_id).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// The repro: a live node path owned by a DIFFERENT device
// ---------------------------------------------------------------------------

describe("W4A4-F5 — a live node path is verified against the anchor", () => {
	beforeEach(resetConfig);
	afterEach(resetConfig);

	test("the crossed renumber routes the ANCHORED camera, never the one that inherited the node", () => {
		const remembered = crossedSnapshots();
		const view = sourcesFrom(crossedDevices(), "/dev/video3", remembered);

		// Pre-fix this returned `/dev/video3` — a live path, so the identity layer
		// never ran — and the engine was handed the Osmo.
		expect(
			realSources.resolveSourceIdentity(
				"/dev/video3",
				view,
				remembered,
				RODE_STABLE,
			),
		).toBe("/dev/video1");

		const routed = realSources.resolveSourceRouting(
			"/dev/video3",
			view,
			remembered,
			RODE_STABLE,
		);
		expect(routed.ok).toBe(true);
		if (!routed.ok) return;
		// The RØDE's bridge, not the Osmo's `libuvch264`.
		expect(routed.pipeline).toBe("usb_mjpeg");
		expect(routed.selected_video_input).toBe("/dev/video1");
	});

	test("an anchored device that is GONE surfaces a typed takeover, never the wrong camera", () => {
		const remembered = crossedSnapshots();
		const view = sourcesFrom(osmoOnlyDevices(), "/dev/video3", remembered);

		const routed = realSources.resolveSourceRouting(
			"/dev/video3",
			view,
			remembered,
			RODE_STABLE,
		);

		expect(routed.ok).toBe(false);
		if (routed.ok) return;
		expect(routed.error).toBe(realSources.SOURCE_TAKEN_OVER_ERROR);
	});

	test("the reconciler PERSISTS the anchored migration across the crossed renumber", () => {
		const remembered = crossedSnapshots();
		const config = getConfig();
		config.source = "/dev/video3";
		config.source_stable_id = RODE_STABLE;
		config.selected_video_input = "/dev/video3";
		config.last_seen_devices = remembered;

		// A committed engine view (so F10a's compare-and-set authorizes the write).
		realSources.applyObservedEngineDevices(crossedDevices());
		const view = sourcesFrom(crossedDevices(), "/dev/video3", remembered);

		expect(realSources.reconcileConfiguredSourceIdentity(view)).toBe(true);
		expect(getConfig().source).toBe("/dev/video1");
		expect(getConfig().selected_video_input).toBe("/dev/video1");
		// The anchor is the operator's word about HARDWARE — a node-path migration
		// never rewrites it.
		expect(getConfig().source_stable_id).toBe(RODE_STABLE);
	});

	test("the anchored camera RETURNING after the takeover is reconciled by the periodic recheck", async () => {
		// Board-measured (2026-07-31): the hotplug refresh fired while only the
		// INHERITOR was enumerated — correctly refusing to migrate — and the
		// anchored camera came back seconds later with no further device-SET
		// change, so nothing re-asked. The 5 s signal recheck is the only
		// periodic re-poke, so it has to be what closes that window.
		await seedCaps();
		const remembered = crossedSnapshots();
		const config = getConfig();
		config.source = "/dev/video3";
		config.source_stable_id = RODE_STABLE;
		config.selected_video_input = "/dev/video3";
		config.last_seen_devices = remembered;

		// (1) The takeover moment: only the Osmo is back, holding the operator's
		//     node. Nothing may migrate — there is nowhere honest to migrate TO.
		realSources.applyObservedEngineDevices(osmoOnlyDevices());
		expect(
			realSources.reconcileConfiguredSourceIdentity(
				sourcesFrom(osmoOnlyDevices(), "/dev/video3", remembered),
			),
		).toBe(false);
		expect(getConfig().source).toBe("/dev/video3");

		// (2) The RØDE re-enumerates on a new node, seen only by the recheck.
		await realSources.recheckSourceSignals(crossedDevices(), {
			fetchEngineDevices: async () => ({
				devices: crossedDevices().map((d) => ({
					input_id: d.input_id,
					device_path: d.device_path,
					display_name: d.display_name,
					media_class: "video" as const,
					kind: d.kind,
					...(d.stable_id !== undefined ? { stable_id: d.stable_id } : {}),
				})),
			}),
		});

		expect(getConfig().source).toBe("/dev/video1");
		expect(getConfig().source_stable_id).toBe(RODE_STABLE);
	});

	test("preview follows the anchor instead of previewing the wrong camera", () => {
		const remembered = crossedSnapshots();
		const view = sourcesFrom(crossedDevices(), "/dev/video3", remembered);
		const frame = JSON.stringify({
			action: "start",
			tier: "mse",
			input_id: "/dev/video3",
		});

		const sent = resolvePreviewStartFrame(frame, (id) =>
			realSources.resolveSourceIdentity(id, view, remembered, RODE_STABLE),
		);

		expect(sent).not.toBeNull();
		expect(JSON.parse(sent as string).input_id).toBe("/dev/video1");
	});

	test("preview REFUSES a taken-over start rather than opening the inheritor", () => {
		// The proof vector from the drill: 45 healthy-looking frames of a camera
		// the operator did not choose. A refusal here is what turns that into the
		// typed `source-unavailable` band.
		const resolver = () => null;
		const frame = JSON.stringify({
			action: "start",
			tier: "mse",
			input_id: "/dev/video3",
		});

		expect(resolvePreviewStartFrame(frame, resolver)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Regression controls — the fix must cost nothing that already worked
// ---------------------------------------------------------------------------

describe("W4A4-F5 — controls: anchored resolution must not weaken renumber", () => {
	beforeEach(resetConfig);
	afterEach(resetConfig);

	test("a genuine SAME-identity renumber still migrates under an anchor", () => {
		// The device the operator chose simply moved. Todos 12/13 protect this.
		const remembered = [
			lastSeen("/dev/video2", "mjpeg", "usb_mjpeg", {
				displayName: RODE_NAME,
				devicePath: "/dev/video2",
				stableId: RODE_STABLE,
				previousIds: ["/dev/video3"],
			}),
		];
		const devices = [
			captureDevice("/dev/video2", "mjpeg", {
				display_name: RODE_NAME,
				stable_id: RODE_STABLE,
			}),
		];
		const view = sourcesFrom(devices, "/dev/video3", remembered);

		expect(
			realSources.resolveSourceIdentity(
				"/dev/video3",
				view,
				remembered,
				RODE_STABLE,
			),
		).toBe("/dev/video2");
	});

	test("an ANCHORLESS legacy config behaves byte-identically to before the fix", () => {
		const remembered = crossedSnapshots();
		const view = sourcesFrom(crossedDevices(), "/dev/video3", remembered);

		// No anchor: the live path short-circuits exactly as it always did.
		expect(
			realSources.resolveSourceIdentity("/dev/video3", view, remembered),
		).toBe("/dev/video3");
		expect(
			realSources.resolveSourceRouting("/dev/video3", view, remembered).ok,
		).toBe(true);
	});

	test("an anchored path still held by its OWN device resolves unchanged", () => {
		const remembered = crossedSnapshots();
		const view = sourcesFrom(preDevices(), "/dev/video3", remembered);

		expect(
			realSources.resolveSourceIdentity(
				"/dev/video3",
				view,
				remembered,
				RODE_STABLE,
			),
		).toBe("/dev/video3");
	});

	test("a live row the engine gives NO stable id for is never overruled by an anchor", () => {
		// Fail-open: an engine that cannot vouch for the device's identity is not
		// evidence that the path was taken over.
		const devices = [
			captureDevice("/dev/video3", "mjpeg", { display_name: RODE_NAME }),
		];
		const view = sourcesFrom(devices, "/dev/video3", []);

		expect(
			realSources.resolveSourceIdentity("/dev/video3", view, [], RODE_STABLE),
		).toBe("/dev/video3");
	});

	test("a TRUE unplug still yields the lost row, not a takeover", () => {
		const remembered = [
			lastSeen("/dev/video3", "mjpeg", "usb_mjpeg", {
				displayName: RODE_NAME,
				devicePath: "/dev/video3",
				stableId: RODE_STABLE,
			}),
		];
		const view = sourcesFrom([], "/dev/video3", remembered);

		const routed = realSources.resolveSourceRouting(
			"/dev/video3",
			view,
			remembered,
			RODE_STABLE,
		);
		expect(routed.ok).toBe(false);
		if (routed.ok) return;
		expect(routed.error).toBe(realSources.SOURCE_LOST_ERROR);
	});
});
