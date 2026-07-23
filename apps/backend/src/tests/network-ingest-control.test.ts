/*
 * Task 6 — network-ingest desired-state + service control + boot reconcile.
 *
 * Covers the PURE topology resolver, the DI'd persist/apply/reconcile pipelines
 * (argv-exact systemctl spies, idempotency, never-throws), the operator_disabled
 * snapshot + sources mapping, and the RPC handler gate order (mocks → emulated →
 * real) reached through the COMPOSED router.
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

import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	GATEWAY_INACTIVE_ERROR,
	NETWORK_INGEST_UNAVAILABLE_ERROR,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import {
	type RuntimeConfig,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import {
	getMockState,
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { isMockGatewayActive } from "../mocks/providers/streaming.ts";
import { getConfig } from "../modules/config.ts";
import {
	deriveNetworkIngestInfo,
	RTMP_GATEWAY_UNIT,
	resetNetworkIngestState,
	SRT_GATEWAY_UNIT,
} from "../modules/network/network-ingest.ts";
import {
	type NetworkIngestControlDeps,
	persistIngestDesired,
	planIngestUnitActions,
	readIngestDesired,
	reconcileIngestDesiredState,
	setIngestEnabled,
} from "../modules/network/network-ingest-control.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import { buildSources } from "../modules/streaming/sources.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { streamingStartProcedure } from "../rpc/procedures/streaming.procedure.ts";
import { appRouter } from "../rpc/router.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const LAN = "192.168.1.100";

// ─── DI harness: a stateful in-memory systemd + config ────────────────────────

type ControlHarness = {
	deps: NetworkIngestControlDeps;
	config: RuntimeConfig;
	active: Set<string>;
	calls: string[][];
	counts: { save: number; refresh: number; sources: number };
};

function makeControlHarness(
	opts: {
		config?: RuntimeConfig;
		active?: string[];
		mediamtxSrt?: boolean;
		srtUnitPresent?: boolean;
		isRealDevice?: boolean;
		systemctlThrows?: boolean;
	} = {},
): ControlHarness {
	const config: RuntimeConfig = opts.config ?? {};
	const active = new Set(opts.active ?? []);
	const calls: string[][] = [];
	const counts = { save: 0, refresh: 0, sources: 0 };
	const deps: NetworkIngestControlDeps = {
		getConfig: () => config,
		saveConfig: () => {
			counts.save++;
		},
		isRealDevice: async () => opts.isRealDevice ?? true,
		systemctl: async (args) => {
			calls.push(["systemctl", ...args]);
			if (opts.systemctlThrows) throw new Error("systemctl failed");
			if (args[0] === "start" && args[1]) active.add(args[1]);
			if (args[0] === "stop" && args[1]) active.delete(args[1]);
			return { stdout: "", stderr: "" };
		},
		isActive: async (unit) => active.has(unit),
		readMediamtxSrt: async () => opts.mediamtxSrt ?? false,
		srtUnitPresent: async () => opts.srtUnitPresent ?? false,
		refreshAndBroadcast: async () => {
			counts.refresh++;
		},
		broadcastSources: () => {
			counts.sources++;
		},
		log: () => {},
	};
	return { deps, config, active, calls, counts };
}

// ─── PURE resolver matrix ─────────────────────────────────────────────────────

describe("planIngestUnitActions — NEW topology (shared MediaMTX unit)", () => {
	const NEW = { mediamtxSrt: true, srtUnitPresent: false };

	test("disable rtmp only → shared unit stays up (stop:[])", () => {
		expect(planIngestUnitActions({ rtmp: false, srt: true }, NEW)).toEqual({
			start: [RTMP_GATEWAY_UNIT],
			stop: [],
		});
	});

	test("disable both → exactly ONE stop of the shared unit", () => {
		expect(planIngestUnitActions({ rtmp: false, srt: false }, NEW)).toEqual({
			start: [],
			stop: [RTMP_GATEWAY_UNIT],
		});
	});

	test("from both-disabled, enable srt → starts the SHARED rtmp unit", () => {
		expect(
			planIngestUnitActions({ rtmp: false, srt: true }, NEW).start,
		).toEqual([RTMP_GATEWAY_UNIT]);
	});

	test("the standalone srt unit is NEVER touched in NEW topology", () => {
		const actions = planIngestUnitActions({ rtmp: true, srt: false }, NEW);
		expect(actions.start).not.toContain(SRT_GATEWAY_UNIT);
		expect(actions.stop).not.toContain(SRT_GATEWAY_UNIT);
	});
});

describe("planIngestUnitActions — OLD topology (separate units)", () => {
	const OLD = { mediamtxSrt: false, srtUnitPresent: true };

	test("srt disable stops ONLY the srt unit", () => {
		expect(planIngestUnitActions({ rtmp: true, srt: false }, OLD)).toEqual({
			start: [RTMP_GATEWAY_UNIT],
			stop: [SRT_GATEWAY_UNIT],
		});
	});

	test("both enabled → both units targeted for start", () => {
		expect(planIngestUnitActions({ rtmp: true, srt: true }, OLD)).toEqual({
			start: [RTMP_GATEWAY_UNIT, SRT_GATEWAY_UNIT],
			stop: [],
		});
	});

	test("absent srt unit-file → srt is never touched", () => {
		const actions = planIngestUnitActions(
			{ rtmp: true, srt: false },
			{ mediamtxSrt: false, srtUnitPresent: false },
		);
		expect(actions.start).toEqual([RTMP_GATEWAY_UNIT]);
		expect(actions.stop).toEqual([]);
	});
});

// ─── readIngestDesired + config round-trip ────────────────────────────────────

describe("readIngestDesired — config round-trip", () => {
	test("old config without the key defaults both true", () => {
		const parsed = runtimeConfigSchema.parse({});
		expect(parsed.network_ingest).toBeUndefined();
		expect(readIngestDesired(parsed)).toEqual({ rtmp: true, srt: true });
	});

	test("a partial config fills the missing protocol via inner default", () => {
		const parsed = runtimeConfigSchema.parse({
			network_ingest: { rtmp_enabled: false },
		});
		expect(parsed.network_ingest).toEqual({
			rtmp_enabled: false,
			srt_enabled: true,
		});
		expect(readIngestDesired(parsed)).toEqual({ rtmp: false, srt: true });
	});
});

// ─── persist / apply / setIngestEnabled (DI) ──────────────────────────────────

describe("setIngestEnabled — persist-first, argv-exact apply", () => {
	test("persists the desired state through the injected singleton FIRST", async () => {
		const h = makeControlHarness({
			active: [RTMP_GATEWAY_UNIT, SRT_GATEWAY_UNIT],
			srtUnitPresent: true,
		});
		const res = await setIngestEnabled("srt", false, h.deps);
		expect(res).toEqual({
			success: true,
			applied: { protocol: "srt", enabled: false },
		});
		expect(h.config.network_ingest).toEqual({
			rtmp_enabled: true,
			srt_enabled: false,
		});
		expect(h.counts.save).toBe(1);
	});

	test("OLD topology: disabling srt stops ONLY the srt unit (argv-exact)", async () => {
		const h = makeControlHarness({
			active: [RTMP_GATEWAY_UNIT, SRT_GATEWAY_UNIT],
			srtUnitPresent: true,
		});
		await setIngestEnabled("srt", false, h.deps);
		expect(h.calls).toEqual([
			["systemctl", "stop", "ceralive-srt-gateway.service"],
		]);
	});

	test("NEW topology: disabling both stops the shared unit exactly once", async () => {
		const h = makeControlHarness({
			config: { network_ingest: { rtmp_enabled: false, srt_enabled: true } },
			active: [RTMP_GATEWAY_UNIT],
			mediamtxSrt: true,
		});
		await setIngestEnabled("srt", false, h.deps);
		expect(h.calls).toEqual([
			["systemctl", "stop", "ceralive-rtmp-gateway.service"],
		]);
	});

	test("a toggle emits BOTH a status frame AND a fresh sources frame", async () => {
		const h = makeControlHarness({
			active: [RTMP_GATEWAY_UNIT, SRT_GATEWAY_UNIT],
			srtUnitPresent: true,
		});
		await setIngestEnabled("rtmp", false, h.deps);
		expect(h.counts.refresh).toBe(1);
		expect(h.counts.sources).toBe(1);
	});

	test("apply failure is swallowed — state still persists, still broadcasts", async () => {
		const h = makeControlHarness({
			active: [RTMP_GATEWAY_UNIT],
			mediamtxSrt: true,
			systemctlThrows: true,
			config: { network_ingest: { rtmp_enabled: true, srt_enabled: true } },
		});
		const res = await setIngestEnabled("rtmp", false, h.deps);
		expect(res.success).toBe(true);
		expect(h.config.network_ingest).toEqual({
			rtmp_enabled: false,
			srt_enabled: true,
		});
		expect(h.counts.refresh).toBe(1);
		expect(h.counts.sources).toBe(1);
	});
});

// ─── reconcileIngestDesiredState (boot) ───────────────────────────────────────

describe("reconcileIngestDesiredState — boot safety", () => {
	test("idempotent: a second run against a reconciled host spawns nothing", async () => {
		const h = makeControlHarness({ active: [], mediamtxSrt: true });
		await reconcileIngestDesiredState(h.deps);
		expect(h.calls).toEqual([
			["systemctl", "start", "ceralive-rtmp-gateway.service"],
		]);
		await reconcileIngestDesiredState(h.deps);
		expect(h.calls.length).toBe(1);
	});

	test("emulated host → no-op, zero spawns", async () => {
		const h = makeControlHarness({ isRealDevice: false, mediamtxSrt: true });
		await reconcileIngestDesiredState(h.deps);
		expect(h.calls).toEqual([]);
		expect(h.counts.refresh).toBe(0);
	});

	test("a rejecting systemctl is swallowed — reconcile never throws", async () => {
		const h = makeControlHarness({
			active: [],
			mediamtxSrt: true,
			systemctlThrows: true,
		});
		await expect(reconcileIngestDesiredState(h.deps)).resolves.toBeUndefined();
	});
});

// ─── persist mutates ONLY the injected singleton (coexistence) ─────────────────

describe("persistIngestDesired — single-writer coexistence", () => {
	test("a later unrelated config write leaves network_ingest intact", () => {
		const config: RuntimeConfig = { max_br: 5000 };
		const deps = makeControlHarness({ config }).deps;
		persistIngestDesired("rtmp", false, deps);
		// A subsequent unrelated writer mutates the SAME singleton object (mirrors
		// streaming.setConfig's field-by-field mutation).
		config.max_br = 8000;
		expect(config.network_ingest?.rtmp_enabled).toBe(false);
		expect(config.max_br).toBe(8000);
	});
});

// ─── operator_disabled snapshot + sources mapping ─────────────────────────────

type SourceCap = GetCapabilitiesResult["sources"][number];

function source(id: string, overrides: Partial<SourceCap> = {}): SourceCap {
	return {
		id,
		supports_audio: true,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
		...overrides,
	};
}

describe("operator_disabled — snapshot + sources", () => {
	test("deriveNetworkIngestInfo attaches operator_disabled ONLY when true", () => {
		const info = deriveNetworkIngestInfo({
			lanIp: LAN,
			rtmpActive: true,
			srtActive: true,
			sourceKinds: new Set(["rtmp", "srt"]),
			operatorDisabled: { rtmp: true, srt: false },
		});
		expect(info.rtmp).toEqual({
			service_active: true,
			url: "rtmp://192.168.1.100:1935/publish/live",
			operator_disabled: true,
		});
		expect(info.srt).toEqual({
			service_active: true,
			url: "srt://192.168.1.100:4001",
		});
	});

	test("an operator-disabled network source renders available:false + disabledInSettings", () => {
		const sources = buildSources({
			sources: [source("rtmp", { supports_resolution_override: false })],
			devices: [],
			networkIngest: {
				rtmp: {
					service_active: true,
					url: "rtmp://x",
					operator_disabled: true,
				},
				srt: null,
			},
		});
		const rtmp = sources.find((s) => s.id === "rtmp");
		expect(rtmp?.available).toBe(false);
		expect(rtmp?.unavailableReason).toBe(
			"live.education.reason.disabledInSettings",
		);
	});
});

// ─── RPC handler gate order (mocks → emulated → real) ─────────────────────────

const CAPS_WITH_INGEST: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "1080p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		source("hdmi"),
		source("rtmp", { supports_resolution_override: false }),
		source("srt", { supports_resolution_override: false }),
		source("test"),
	],
};

function provide(snapshot: GetCapabilitiesResult) {
	return {
		fetchEngineCapabilities: async () => ({
			caps: snapshot,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	};
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

describe("network.setIngestEnabled handler — emulated (no mocks)", () => {
	beforeAll(() => {
		stopMockService();
	});

	test("emulated non-mock host → UNAVAILABLE, config untouched", async () => {
		const config = getConfig();
		const prior = config.network_ingest;
		delete (config as { network_ingest?: unknown }).network_ingest;
		await withDeviceType("emulated", async () => {
			const res = await call(
				appRouter.network.setIngestEnabled,
				{ protocol: "rtmp", enabled: false },
				{ context: makeContext() },
			);
			expect(res).toEqual({
				success: false,
				error: NETWORK_INGEST_UNAVAILABLE_ERROR,
			});
		});
		expect(config.network_ingest).toBeUndefined();
		config.network_ingest = prior;
	});
});

describe("network.setIngestEnabled handler — mocks (zero spawns)", () => {
	const savedMockMode = process.env.MOCK_MODE;

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide(CAPS_WITH_INGEST));
	});
	beforeEach(() => {
		getConfig().pipeline = undefined;
		getConfig().network_ingest = { rtmp_enabled: true, srt_enabled: true };
	});
	afterEach(() => {
		setStreamingState(false);
		updateStatus(false);
		resetMockState();
		// The real setIngestEnabled RPC writes the module-level network-ingest
		// cache; clear it so an rtmp-active snapshot never leaks into a later file.
		resetNetworkIngestState();
	});
	afterAll(async () => {
		stopMockService();
		setMockHardware("rk3588");
		await initPipelines();
		resetNetworkIngestState();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	test("reachable through the COMPOSED router; flips BOTH mock signals", async () => {
		const res = await call(
			appRouter.network.setIngestEnabled,
			{ protocol: "rtmp", enabled: false },
			{ context: makeContext() },
		);
		expect(res).toEqual({
			success: true,
			applied: { protocol: "rtmp", enabled: false },
		});
		expect(getMockState().networkIngestActive.rtmp).toBe(false);
		expect(isMockGatewayActive("rtmp")).toBe(false);
		expect(getConfig().network_ingest?.rtmp_enabled).toBe(false);
	});

	test("mock start-gate shares ONE truth with the toggle", async () => {
		await call(
			appRouter.network.setIngestEnabled,
			{ protocol: "rtmp", enabled: false },
			{ context: makeContext() },
		);
		const blocked = await call(
			streamingStartProcedure,
			{ pipeline: "rtmp" },
			{ context: makeContext() },
		);
		expect(blocked).toMatchObject({
			success: false,
			is_streaming: false,
			error: GATEWAY_INACTIVE_ERROR,
		});

		await call(
			appRouter.network.setIngestEnabled,
			{ protocol: "rtmp", enabled: true },
			{ context: makeContext() },
		);
		const ok = await call(
			streamingStartProcedure,
			{ pipeline: "rtmp" },
			{ context: makeContext() },
		);
		expect(ok.success).toBe(true);
		expect(ok).not.toHaveProperty("error");
	});
});
