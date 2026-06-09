/*
 * Task 23 — kiosk toggle state machine (DC-2, docs/KIOSK_STATE_MACHINE.md).
 *
 * RED-first coverage for the backend half of the kiosk lifecycle: the pure
 * state classifier (all five states), the crash-loop auto-disable rule, every
 * one of the six transitions, and the four authenticated RPC procedures.
 *
 * All systemd interaction is injected through the `KioskDeps` surface (mirrors
 * the `SshStatusDeps` pattern in modules/system/ssh.ts) so the suite never
 * shells out to a real `systemctl`. The injected `systemctl` spy records the
 * exact argv the state machine issued; the injected `broadcast` spy is the
 * oracle for client-facing state events.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KIOSK_UNAVAILABLE_ERROR, type KioskStatus } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { getConfig } from "../modules/config.ts";
import {
	classifyKioskState,
	getKioskLiveState,
	initKiosk,
	isCrashLoop,
	type KioskDeps,
	kioskConfigure,
	kioskStart,
	kioskStop,
	type OskSignal,
	pollKioskOnce,
	resetKioskDeps,
	setKioskDeps,
	stopKioskPolling,
} from "../modules/system/kiosk.ts";
import {
	kioskConfigureProcedure,
	kioskOskProcedure,
	kioskStartProcedure,
	kioskStatusProcedure,
	kioskStopProcedure,
} from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

type KioskSignals = {
	isFailed: boolean;
	isActive: boolean;
	nRestarts: number;
	marker: boolean;
};

type KioskHarness = {
	deps: KioskDeps;
	systemctlCalls: string[][];
	broadcasts: KioskStatus[];
	markerRemoved: () => number;
	signals: KioskSignals;
};

function makeHarness(initial: Partial<KioskSignals> = {}): KioskHarness {
	const signals: KioskSignals = {
		isFailed: false,
		isActive: false,
		nRestarts: 0,
		marker: false,
		...initial,
	};
	const systemctlCalls: string[][] = [];
	const broadcasts: KioskStatus[] = [];
	let markerRemovedCount = 0;

	const deps: KioskDeps = {
		systemctl: async (args) => {
			systemctlCalls.push(args);
			return { stdout: "", stderr: "" };
		},
		isFailed: async () => signals.isFailed,
		isActive: async () => signals.isActive,
		getNRestarts: async () => signals.nRestarts,
		noDisplayMarkerExists: async () => signals.marker,
		removeNoDisplayMarker: async () => {
			markerRemovedCount++;
			signals.marker = false;
		},
		broadcast: (status) => {
			broadcasts.push(status);
		},
	};

	return {
		deps,
		systemctlCalls,
		broadcasts,
		markerRemoved: () => markerRemovedCount,
		signals,
	};
}

function makeContext(authenticated = true): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: authenticated, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => authenticated,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function lastBroadcast(h: KioskHarness): KioskStatus | undefined {
	return h.broadcasts[h.broadcasts.length - 1];
}

function resetKioskConfig() {
	const config = getConfig();
	config.kiosk_enabled = false;
	config.kiosk_last_state = "disabled";
	config.kiosk_display = "lcd";
	config.kiosk_touch = true;
	config.kiosk_motion = true;
	config.kiosk_performance = "balanced";
}

beforeEach(() => {
	stopKioskPolling();
	resetKioskConfig();
	// Sync the live state to `disabled` without touching systemd: with
	// kiosk_enabled=false, initKiosk neither polls nor arms the interval.
	initKiosk(makeHarness().deps);
});

afterEach(() => {
	stopKioskPolling();
	resetKioskDeps();
});

describe("classifyKioskState — the five DC-2 states", () => {
	test("disabled when the toggle is off", () => {
		expect(
			classifyKioskState({
				enabled: false,
				isFailed: false,
				isActive: false,
				nRestarts: 0,
				noDisplayMarker: false,
			}),
		).toBe("disabled");
	});

	test("enabled-stopped when on but neither active nor failed", () => {
		expect(
			classifyKioskState({
				enabled: true,
				isFailed: false,
				isActive: false,
				nRestarts: 0,
				noDisplayMarker: false,
			}),
		).toBe("enabled-stopped");
	});

	test("enabled-running when the unit is active", () => {
		expect(
			classifyKioskState({
				enabled: true,
				isFailed: false,
				isActive: true,
				nRestarts: 0,
				noDisplayMarker: false,
			}),
		).toBe("enabled-running");
	});

	test("enabled-failed when failed without the no-display marker", () => {
		expect(
			classifyKioskState({
				enabled: true,
				isFailed: true,
				isActive: false,
				nRestarts: 5,
				noDisplayMarker: false,
			}),
		).toBe("enabled-failed");
	});

	test("failed-no-display when failed with the marker present", () => {
		expect(
			classifyKioskState({
				enabled: true,
				isFailed: true,
				isActive: false,
				nRestarts: 5,
				noDisplayMarker: true,
			}),
		).toBe("failed-no-display");
	});
});

describe("isCrashLoop — auto-disable classification", () => {
	test("true when failed and NRestarts >= threshold without the marker", () => {
		expect(
			isCrashLoop({ isFailed: true, noDisplayMarker: false, nRestarts: 3 }),
		).toBe(true);
	});

	test("false when NRestarts is below the threshold", () => {
		expect(
			isCrashLoop({ isFailed: true, noDisplayMarker: false, nRestarts: 2 }),
		).toBe(false);
	});

	test("false for a display-unplug failure (marker present)", () => {
		expect(
			isCrashLoop({ isFailed: true, noDisplayMarker: true, nRestarts: 9 }),
		).toBe(false);
	});
});

describe("kioskStart (T1: toggle-on)", () => {
	test("persists the toggle, snaps to enabled-stopped, unmasks + enable --now", async () => {
		const h = makeHarness();
		setKioskDeps(h.deps);

		const status = await kioskStart(h.deps);

		expect(getConfig().kiosk_enabled).toBe(true);
		expect(status.state).toBe("enabled-stopped");
		expect(getKioskLiveState()).toBe("enabled-stopped");
		expect(getConfig().kiosk_last_state).toBe("enabled-stopped");
		expect(h.systemctlCalls).toContainEqual(["unmask", "kiosk.service"]);
		expect(h.systemctlCalls).toContainEqual([
			"enable",
			"--now",
			"kiosk.service",
		]);
		expect(lastBroadcast(h)?.state).toBe("enabled-stopped");

		stopKioskPolling();
	});
});

describe("pollKioskOnce (T2: start resolves OK)", () => {
	test("enabled-stopped → enabled-running once the unit reports active", async () => {
		const h = makeHarness();
		getConfig().kiosk_enabled = true;
		setKioskDeps(h.deps);

		expect(await pollKioskOnce(h.deps)).toBe("enabled-stopped");

		h.signals.isActive = true;
		const before = h.broadcasts.length;

		expect(await pollKioskOnce(h.deps)).toBe("enabled-running");
		expect(getKioskLiveState()).toBe("enabled-running");
		expect(h.broadcasts.length).toBeGreaterThan(before);
		expect(lastBroadcast(h)?.state).toBe("enabled-running");
	});
});

describe("kioskStop (T3: toggle-off)", () => {
	test("from enabled-running: stop + disable + mask, remove marker, persist disabled", async () => {
		const h = makeHarness({ isActive: true });
		getConfig().kiosk_enabled = true;
		setKioskDeps(h.deps);
		await pollKioskOnce(h.deps);
		expect(getKioskLiveState()).toBe("enabled-running");

		h.systemctlCalls.length = 0;
		h.broadcasts.length = 0;
		const status = await kioskStop(h.deps);

		expect(getConfig().kiosk_enabled).toBe(false);
		expect(status.state).toBe("disabled");
		expect(getKioskLiveState()).toBe("disabled");
		expect(h.systemctlCalls).toContainEqual(["stop", "kiosk.service"]);
		expect(h.systemctlCalls).toContainEqual(["disable", "kiosk.service"]);
		expect(h.systemctlCalls).toContainEqual(["mask", "kiosk.service"]);
		expect(h.markerRemoved()).toBeGreaterThanOrEqual(1);
		expect(lastBroadcast(h)?.state).toBe("disabled");
	});

	test("from failed-no-display: toggle-off returns to disabled", async () => {
		const h = makeHarness({ isFailed: true, marker: true, nRestarts: 0 });
		getConfig().kiosk_enabled = true;
		setKioskDeps(h.deps);
		expect(await pollKioskOnce(h.deps)).toBe("failed-no-display");

		const status = await kioskStop(h.deps);
		expect(status.state).toBe("disabled");
		expect(getConfig().kiosk_enabled).toBe(false);
	});
});

describe("pollKioskOnce (T6: display unplugged)", () => {
	test("failed + marker → failed-no-display and does NOT auto-disable", async () => {
		const h = makeHarness({ isFailed: true, marker: true, nRestarts: 9 });
		getConfig().kiosk_enabled = true;
		setKioskDeps(h.deps);

		expect(await pollKioskOnce(h.deps)).toBe("failed-no-display");
		expect(getConfig().kiosk_enabled).toBe(true);
		expect(h.systemctlCalls).not.toContainEqual(["mask", "kiosk.service"]);
	});
});

describe("pollKioskOnce (T4 crash-loop → T5 auto-disable)", () => {
	test("failed + NRestarts >= 3 (no marker): persist off, mask, resolve disabled", async () => {
		const h = makeHarness({ isFailed: true, marker: false, nRestarts: 3 });
		getConfig().kiosk_enabled = true;
		setKioskDeps(h.deps);

		const state = await pollKioskOnce(h.deps);

		expect(state).toBe("disabled");
		expect(getKioskLiveState()).toBe("disabled");
		expect(getConfig().kiosk_enabled).toBe(false);
		expect(getConfig().kiosk_last_state).toBe("disabled");
		expect(h.systemctlCalls).toContainEqual(["mask", "kiosk.service"]);
		expect(lastBroadcast(h)?.enabled).toBe(false);
		expect(lastBroadcast(h)?.state).toBe("disabled");
	});

	test("single-shot failure (NRestarts < 3) holds at enabled-failed, no auto-disable", async () => {
		const h = makeHarness({ isFailed: true, marker: false, nRestarts: 1 });
		getConfig().kiosk_enabled = true;
		setKioskDeps(h.deps);

		expect(await pollKioskOnce(h.deps)).toBe("enabled-failed");
		expect(getConfig().kiosk_enabled).toBe(true);
		expect(h.systemctlCalls).not.toContainEqual(["mask", "kiosk.service"]);
	});
});

describe("kioskConfigure", () => {
	test("persists display + touch + motion + performance and returns applied", () => {
		const h = makeHarness();
		setKioskDeps(h.deps);

		const applied = kioskConfigure(
			{ display: "eink", touch: false, motion: false, performance: "low" },
			h.deps,
		);

		expect(applied).toEqual({
			display: "eink",
			touch: false,
			motion: false,
			performance: "low",
		});
		const config = getConfig();
		expect(config.kiosk_display).toBe("eink");
		expect(config.kiosk_touch).toBe(false);
		expect(config.kiosk_motion).toBe(false);
		expect(config.kiosk_performance).toBe("low");
		expect(lastBroadcast(h)?.display).toBe("eink");
	});
});

describe("system.kiosk* RPC procedures", () => {
	// The four action handlers gate on isRealDevice() (T13); these delegation
	// tests pin the real-device branch via the explicit override so the suite is
	// deterministic on any host.
	let savedDeviceType: string | undefined;
	beforeEach(() => {
		savedDeviceType = process.env.CERALIVE_DEVICE_TYPE;
		process.env.CERALIVE_DEVICE_TYPE = "real";
	});
	afterEach(() => {
		if (savedDeviceType === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
		else process.env.CERALIVE_DEVICE_TYPE = savedDeviceType;
	});

	test("kioskStatus returns the persisted toggle + live state", async () => {
		setKioskDeps(makeHarness().deps);

		const result = await call(kioskStatusProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.enabled).toBe(false);
		expect(result.state).toBe("disabled");
		expect(result.display).toBe("lcd");
	});

	test("kioskStart resolves applied { enabled:true, state:'enabled-stopped' }", async () => {
		setKioskDeps(makeHarness().deps);

		const result = await call(kioskStartProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(result.applied.enabled).toBe(true);
		expect(result.applied.state).toBe("enabled-stopped");
	});

	test("kioskStop resolves applied { enabled:false, state:'disabled' }", async () => {
		const h = makeHarness({ isActive: true });
		getConfig().kiosk_enabled = true;
		setKioskDeps(h.deps);
		await pollKioskOnce(h.deps);

		const result = await call(kioskStopProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(result.applied.enabled).toBe(false);
		expect(result.applied.state).toBe("disabled");
	});

	test("kioskConfigure persists via RPC and echoes applied", async () => {
		setKioskDeps(makeHarness().deps);

		const result = await call(
			kioskConfigureProcedure,
			{ display: "mono", touch: true, motion: false, performance: "high" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied).toEqual({
			display: "mono",
			touch: true,
			motion: false,
			performance: "high",
		});
		expect(getConfig().kiosk_display).toBe("mono");
	});

	test("kiosk procedures reject an unauthenticated caller", async () => {
		setKioskDeps(makeHarness().deps);

		await expect(
			call(kioskStatusProcedure, undefined, { context: makeContext(false) }),
		).rejects.toThrow();
		await expect(
			call(
				kioskConfigureProcedure,
				{ display: "lcd", touch: true, motion: true, performance: "balanced" },
				{ context: makeContext(false) },
			),
		).rejects.toThrow();
	});
});

/*
 * T13 — the four action handlers gate on isRealDevice(). On a dev/CI/emulated
 * host the user-reported bug was that toggling kiosk pushed the developer's own
 * machine into host kiosk mode. The gate must short-circuit BEFORE any kiosk
 * module function runs, so systemd is never touched. The harness spies the whole
 * KioskDeps surface (systemctl + oskSignal + broadcast); a gated handler must
 * leave every spy untouched and the persisted config unchanged.
 */
describe("kiosk RPC isRealDevice() gate (T13)", () => {
	type GateHarness = {
		deps: KioskDeps;
		systemctlCalls: string[][];
		broadcasts: KioskStatus[];
		oskSignals: OskSignal[];
	};

	function makeGateHarness(): GateHarness {
		const systemctlCalls: string[][] = [];
		const broadcasts: KioskStatus[] = [];
		const oskSignals: OskSignal[] = [];
		const deps: KioskDeps = {
			systemctl: async (args) => {
				systemctlCalls.push(args);
				return { stdout: "", stderr: "" };
			},
			isFailed: async () => false,
			isActive: async () => false,
			getNRestarts: async () => 0,
			noDisplayMarkerExists: async () => false,
			removeNoDisplayMarker: async () => {},
			oskSignal: async (signal) => {
				oskSignals.push(signal);
			},
			broadcast: (status) => {
				broadcasts.push(status);
			},
		};
		return { deps, systemctlCalls, broadcasts, oskSignals };
	}

	let savedDeviceType: string | undefined;
	beforeEach(() => {
		savedDeviceType = process.env.CERALIVE_DEVICE_TYPE;
	});
	afterEach(() => {
		if (savedDeviceType === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
		else process.env.CERALIVE_DEVICE_TYPE = savedDeviceType;
	});

	describe("emulated host — every action returns unavailable, touches nothing", () => {
		beforeEach(() => {
			process.env.CERALIVE_DEVICE_TYPE = "emulated";
		});

		test("kioskStart: unavailable, never unmasks the unit, leaves toggle off", async () => {
			const h = makeGateHarness();
			setKioskDeps(h.deps);

			const result = await call(kioskStartProcedure, undefined, {
				context: makeContext(),
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe(KIOSK_UNAVAILABLE_ERROR);
			expect(result.applied).toBeUndefined();
			expect(h.systemctlCalls).toHaveLength(0);
			expect(getConfig().kiosk_enabled).toBe(false);
		});

		test("kioskStop: unavailable, never stops/masks the unit", async () => {
			const h = makeGateHarness();
			setKioskDeps(h.deps);

			const result = await call(kioskStopProcedure, undefined, {
				context: makeContext(),
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe(KIOSK_UNAVAILABLE_ERROR);
			expect(result.applied).toBeUndefined();
			expect(h.systemctlCalls).toHaveLength(0);
		});

		test("kioskConfigure: unavailable, never persists or broadcasts", async () => {
			const h = makeGateHarness();
			setKioskDeps(h.deps);

			const result = await call(
				kioskConfigureProcedure,
				{ display: "eink", touch: false, motion: false, performance: "low" },
				{ context: makeContext() },
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe(KIOSK_UNAVAILABLE_ERROR);
			expect(result.applied).toBeUndefined();
			expect(h.broadcasts).toHaveLength(0);
			expect(getConfig().kiosk_display).toBe("lcd");
		});

		test("kioskOsk: unavailable, never signals wvkbd", async () => {
			const h = makeGateHarness();
			setKioskDeps(h.deps);

			const result = await call(
				kioskOskProcedure,
				{ visible: true },
				{ context: makeContext() },
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe(KIOSK_UNAVAILABLE_ERROR);
			expect(h.oskSignals).toHaveLength(0);
		});
	});

	describe("real device — handlers delegate to the kiosk module as before", () => {
		beforeEach(() => {
			process.env.CERALIVE_DEVICE_TYPE = "real";
		});

		test("kioskStart commits the toggle and drives the unit", async () => {
			const h = makeGateHarness();
			setKioskDeps(h.deps);

			const result = await call(kioskStartProcedure, undefined, {
				context: makeContext(),
			});

			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
			expect(result.applied?.enabled).toBe(true);
			expect(result.applied?.state).toBe("enabled-stopped");
			expect(getConfig().kiosk_enabled).toBe(true);
			expect(h.systemctlCalls).toContainEqual(["unmask", "kiosk.service"]);

			stopKioskPolling();
		});

		test("kioskConfigure persists the profile and broadcasts", async () => {
			const h = makeGateHarness();
			setKioskDeps(h.deps);

			const result = await call(
				kioskConfigureProcedure,
				{ display: "mono", touch: true, motion: false, performance: "high" },
				{ context: makeContext() },
			);

			expect(result.success).toBe(true);
			expect(result.applied).toEqual({
				display: "mono",
				touch: true,
				motion: false,
				performance: "high",
			});
			expect(getConfig().kiosk_display).toBe("mono");
			expect(h.broadcasts.length).toBeGreaterThan(0);
		});

		test("kioskOsk signals wvkbd to show", async () => {
			const h = makeGateHarness();
			setKioskDeps(h.deps);

			const result = await call(
				kioskOskProcedure,
				{ visible: true },
				{ context: makeContext() },
			);

			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
			expect(h.oskSignals).toContainEqual("SIGUSR2");
		});
	});
});
