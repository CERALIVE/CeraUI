/*
 * F10 — the reconciler must never overrule the operator, and must never
 * re-point a selection at a DIFFERENT physical device.
 *
 * Both halves were confirmed on hardware (192.168.78.131) during the wave-3
 * device-quality QA and recorded in that effort's issue register. Neither was
 * covered by `source-identity-renumber.test.ts` / `source-renumber-dedup.test.ts`,
 * because both of those drive the SUCCESSFUL-probe case and the whole defect
 * lives in what happens when the probe is NOT succeeding — or when the remembered
 * evidence is ambiguous.
 *
 * F10a — stale-cache-after-save. `reconcileConfiguredSourceIdentity` decides
 * against `getSourcesMessage()`, which is built from the engine-device cache that
 * `tryRefreshEngineDeviceCache` deliberately RETAINS across a failed fetch. During
 * a ~5 minute cerastream outage every `list-devices` timed out, so that cache was
 * minutes old — and it still authorized a config MUTATION 7 ms after an operator
 * `setConfig({source})` had saved a different, CORRECT id:
 *
 *   20:05:47.125 debug sources: engine device fetch failed; retaining last-known device cache
 *   20:05:47.132 info  sources: configured source re-enumerated under a new node path
 *                            — migrated by stable identity {"from":"/dev/video0","to":"/dev/video3"}
 *
 * F10b — renumber-to-different-device. The migration resolves the persisted id
 * through `last_seen_devices`, and `/dev/videoN` is recycled: the board's own
 * snapshot list carried TWO different physical devices answering to
 * `/dev/video3` (the HDMI-RX holding it outright, the Osmo remembering it as a
 * retired alias). Whichever one the lookup happened to reach decided which
 * hardware the operator's selection now named.
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
import type {
	CaptureDevice,
	DeviceKind,
	NetworkIngest,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import type { LastSeenDevice } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import * as configMigration from "../modules/streaming/config-migration.ts";
import * as sourcesModule from "../modules/streaming/sources.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// Snapshot the REAL modules at load time — `mock.module` mutates the namespace in
// place, so the restore in afterAll must come from here (same rule as
// `config-source-migration.test.ts`).
const realSources = { ...sourcesModule };
const realConfigMigration = { ...configMigration };

const SOURCES_PATH = "../modules/streaming/sources.ts";
const CONFIG_MIGRATION_PATH = "../modules/streaming/config-migration.ts";

const NO_INGEST: NetworkIngest = { rtmp: null, srt: null };

const HDMI_NAME = "HDMI Input";
const HDMI_STABLE = "port:fdee0000.hdmirx-controller";
const OSMO_NAME = "DJIPocket3: OsmoPocket3";
const OSMO_STABLE = "usb:2ca3:0023:DJI_DJIPocket3_123456789ABCDEF";
const RODE_NAME = "RØDE HDMI to USB-C: RØDE HDMI";
const RODE_STABLE = "usb:19f7:0037";

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

/** Build the `sources` view the reconciler is handed, from a given device list. */
function sourcesFrom(
	devices: readonly CaptureDevice[],
	lastStreamedSource: string,
	lastSeenDevices: readonly LastSeenDevice[],
): StreamSource[] {
	return realSources.buildSources({
		sources: goldenCapSources(),
		devices,
		networkIngest: NO_INGEST,
		lastStreamedSource,
		lastSeenDevices,
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

/**
 * The list the OPERATOR's UI (and therefore the `setConfig` procedure) is looking
 * at: the board AFTER the renumber, with the HDMI-RX on `/dev/video0`. This is
 * deliberately NOT the list the reconciler sees — the whole defect is that the
 * two disagree because the engine-device cache could not be refreshed.
 */
const OPERATOR_VIEW: StreamSource[] = [
	{
		origin: "capture",
		id: "/dev/video0",
		pipelineId: "hdmi",
		kind: "hdmi",
		displayName: HDMI_NAME,
		devicePath: "/dev/video0",
		stableId: HDMI_STABLE,
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable",
		available: true,
	},
	{
		origin: "capture",
		id: "/dev/video1",
		pipelineId: "usb_mjpeg",
		kind: "mjpeg",
		displayName: RODE_NAME,
		devicePath: "/dev/video1",
		stableId: RODE_STABLE,
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "selectable",
		available: true,
	},
];

// ---------------------------------------------------------------------------
// F10a — a stale engine view may not overwrite a NEWER operator save
// ---------------------------------------------------------------------------

describe("F10a — stale-cache-after-save", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	let setConfigProcedure: Awaited<
		typeof import("../rpc/procedures/streaming.procedure.ts")
	>["setConfigProcedure"];

	beforeAll(async () => {
		delete process.env.MOCK_MODE;
		process.env.NODE_ENV = "test";

		// The operator's own view — fresh, and NOT what the reconciler is handed.
		mock.module(SOURCES_PATH, () => ({
			...realSources,
			getSourcesMessage: () => ({
				hardware: "rk3588" as const,
				sources: OPERATOR_VIEW,
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

	beforeEach(() => {
		realSources.resetEngineDeviceCache();
		const config = getConfig();
		config.source = undefined;
		config.source_stable_id = undefined;
		config.selected_video_input = undefined;
		config.last_seen_devices = [];
	});

	afterEach(() => {
		realSources.resetEngineDeviceCache();
		const config = getConfig();
		config.source = undefined;
		config.source_stable_id = undefined;
		config.selected_video_input = undefined;
		config.last_seen_devices = [];
	});

	/**
	 * The board's persisted memory of the HDMI-RX AFTER the renumber: it holds
	 * `/dev/video0` now and remembers `/dev/video3` as a retired alias. Exactly
	 * one remembered device answers to `/dev/video0`, so F10b's ambiguity rule is
	 * NOT what is under test here — only the freshness of the engine view is.
	 */
	function hdmiSnapshot(): LastSeenDevice {
		return lastSeen("/dev/video0", "hdmi", "hdmi", {
			displayName: HDMI_NAME,
			devicePath: "/dev/video0",
			stableId: HDMI_STABLE,
			previousIds: ["/dev/video3"],
		});
	}

	/** The engine view as it was BEFORE the outage: HDMI-RX still on video3. */
	function preOutageDevices(): CaptureDevice[] {
		return [
			captureDevice("/dev/video3", "hdmi", {
				display_name: HDMI_NAME,
				stable_id: HDMI_STABLE,
			}),
		];
	}

	test("a reconciliation drawn from a PRE-SAVE engine view leaves the operator's selection alone", async () => {
		// (1) The engine answers once, and that answer becomes the current view.
		realSources.applyObservedEngineDevices(preOutageDevices());

		// (2) The board renumbers and cerastream goes unreachable — every
		//     `list-devices` throws, so the cache is RETAINED and never re-committed.
		//     The operator, looking at the fresh list, saves the CORRECT id.
		const saved = await call(
			setConfigProcedure,
			{ source: "/dev/video0" },
			{ context: makeContext() },
		);
		expect(saved.success).toBe(true);
		expect(getConfig().source).toBe("/dev/video0");

		getConfig().last_seen_devices = [hdmiSnapshot()];

		// (3) A `sources` broadcast runs the reconciler against that stale view.
		const stale = sourcesFrom(
			realSources.getEngineDeviceCache(),
			"/dev/video0",
			[hdmiSnapshot()],
		);
		// The stale view genuinely still shows the device on its old node path —
		// this is the evidence the reconciler used to migrate.
		expect(stale.some((s) => s.id === "/dev/video3")).toBe(true);

		const changed = realSources.reconcileConfiguredSourceIdentity(stale);

		expect(changed).toBe(false);
		expect(getConfig().source).toBe("/dev/video0");
	});

	test("the SAME view authorizes the migration once the engine has answered again", async () => {
		realSources.applyObservedEngineDevices(preOutageDevices());

		const saved = await call(
			setConfigProcedure,
			{ source: "/dev/video0" },
			{ context: makeContext() },
		);
		expect(saved.success).toBe(true);
		getConfig().last_seen_devices = [hdmiSnapshot()];

		// The engine comes back and re-commits the very same view. The reconciler
		// is no longer reasoning from evidence older than the operator's intent, so
		// it is authorized again — and this time it is a genuine renumber.
		realSources.applyObservedEngineDevices(preOutageDevices());

		const view = sourcesFrom(
			realSources.getEngineDeviceCache(),
			"/dev/video0",
			[hdmiSnapshot()],
		);
		expect(realSources.reconcileConfiguredSourceIdentity(view)).toBe(true);
		expect(getConfig().source).toBe("/dev/video3");
	});

	test("a genuine mid-stream renumber still migrates after an operator save", async () => {
		// The regression this must not cause: refusing every migration that follows
		// a save. A save, then a FRESH engine answer showing the replugged RØDE on
		// a new node, must still self-heal.
		realSources.applyObservedEngineDevices([
			captureDevice("/dev/video1", "mjpeg", {
				display_name: RODE_NAME,
				stable_id: RODE_STABLE,
			}),
		]);

		const saved = await call(
			setConfigProcedure,
			{ source: "/dev/video1" },
			{ context: makeContext() },
		);
		expect(saved.success).toBe(true);

		const rodeSnapshot = lastSeen("/dev/video1", "mjpeg", "usb_mjpeg", {
			displayName: RODE_NAME,
			devicePath: "/dev/video1",
			stableId: RODE_STABLE,
		});
		getConfig().last_seen_devices = [rodeSnapshot];

		realSources.applyObservedEngineDevices([
			captureDevice("/dev/video2", "mjpeg", {
				display_name: RODE_NAME,
				stable_id: RODE_STABLE,
			}),
		]);

		const view = sourcesFrom(
			realSources.getEngineDeviceCache(),
			"/dev/video1",
			[rodeSnapshot],
		);
		expect(realSources.reconcileConfiguredSourceIdentity(view)).toBe(true);
		expect(getConfig().source).toBe("/dev/video2");
	});
});

// ---------------------------------------------------------------------------
// F10b — a node path claimed by two devices names neither of them
// ---------------------------------------------------------------------------

describe("F10b — renumber-to-different-device", () => {
	beforeEach(() => {
		realSources.resetEngineDeviceCache();
		const config = getConfig();
		config.source = undefined;
		config.source_stable_id = undefined;
		config.selected_video_input = undefined;
		config.last_seen_devices = [];
	});

	afterEach(() => {
		realSources.resetEngineDeviceCache();
		const config = getConfig();
		config.source = undefined;
		config.source_stable_id = undefined;
		config.selected_video_input = undefined;
		config.last_seen_devices = [];
	});

	/** The Osmo, which held `/dev/video3` when the operator picked it and has
	 *  since renumbered to `/dev/video5` (libuvc renumbers on every cycle). */
	function osmoSnapshot(): LastSeenDevice {
		return lastSeen("/dev/video5", "uvc_h264", "libuvch264", {
			displayName: OSMO_NAME,
			devicePath: "/dev/video5",
			stableId: OSMO_STABLE,
			previousIds: ["/dev/video3"],
		});
	}

	/** The HDMI-RX, which took `/dev/video3` after the Osmo vacated it. */
	function hdmiOnVideo3(): LastSeenDevice {
		return lastSeen("/dev/video3", "hdmi", "hdmi", {
			displayName: HDMI_NAME,
			devicePath: "/dev/video3",
			stableId: HDMI_STABLE,
		});
	}

	/** The live board: HDMI-RX on video0, Osmo unplugged. */
	function liveDevices(): CaptureDevice[] {
		return [
			captureDevice("/dev/video0", "hdmi", {
				display_name: HDMI_NAME,
				stable_id: HDMI_STABLE,
			}),
		];
	}

	test("refuses to migrate a node path TWO remembered devices answer to", () => {
		const remembered = [osmoSnapshot(), hdmiOnVideo3()];
		const config = getConfig();
		config.source = "/dev/video3";
		config.last_seen_devices = remembered;

		realSources.applyObservedEngineDevices(liveDevices());
		const view = sourcesFrom(liveDevices(), "/dev/video3", remembered);

		const changed = realSources.reconcileConfiguredSourceIdentity(view);

		// Migrating here would silently re-point the operator's Osmo selection at
		// the HDMI-RX — a DIFFERENT physical device — and survive a reboot.
		expect(changed).toBe(false);
		expect(getConfig().source).toBe("/dev/video3");
	});

	test("resolveSourceIdentity leaves an ambiguous node path untouched", () => {
		const remembered = [osmoSnapshot(), hdmiOnVideo3()];
		const view = sourcesFrom(liveDevices(), "/dev/video3", remembered);

		expect(
			realSources.resolveSourceIdentity("/dev/video3", view, remembered),
		).toBe("/dev/video3");
	});

	test("an UNAMBIGUOUS retired alias still migrates (renumber unweakened)", () => {
		// The same shape with the second claimant removed: exactly one remembered
		// device answers to `/dev/video3`, and it IS the live HDMI-RX.
		const remembered = [
			lastSeen("/dev/video0", "hdmi", "hdmi", {
				displayName: HDMI_NAME,
				devicePath: "/dev/video0",
				stableId: HDMI_STABLE,
				previousIds: ["/dev/video3"],
			}),
		];
		const config = getConfig();
		config.source = "/dev/video3";
		config.selected_video_input = "/dev/video3";
		config.last_seen_devices = remembered;

		realSources.applyObservedEngineDevices(liveDevices());
		const view = sourcesFrom(liveDevices(), "/dev/video3", remembered);

		expect(realSources.reconcileConfiguredSourceIdentity(view)).toBe(true);
		expect(getConfig().source).toBe("/dev/video0");
		expect(getConfig().selected_video_input).toBe("/dev/video0");
	});

	test("two SNAPSHOTS of the same device are not ambiguous (dedupe self-heal)", () => {
		// A `config.json` written before the identity fold carries duplicate rows
		// for ONE camera. They share a stable identity, so the path has one owner
		// and the migration must still fire.
		const remembered = [
			lastSeen("/dev/video0", "hdmi", "hdmi", {
				displayName: HDMI_NAME,
				devicePath: "/dev/video0",
				stableId: HDMI_STABLE,
				previousIds: ["/dev/video3"],
			}),
			lastSeen("/dev/video3", "hdmi", "hdmi", {
				displayName: HDMI_NAME,
				devicePath: "/dev/video3",
				stableId: HDMI_STABLE,
			}),
		];
		const config = getConfig();
		config.source = "/dev/video3";
		config.last_seen_devices = remembered;

		realSources.applyObservedEngineDevices(liveDevices());
		const view = sourcesFrom(liveDevices(), "/dev/video3", remembered);

		expect(realSources.reconcileConfiguredSourceIdentity(view)).toBe(true);
		expect(getConfig().source).toBe("/dev/video0");
	});
});
