/*
 * T6 — dev-parity for the kiosk subsystem (DC-2 state machine).
 *
 * Proves the three-way dependency split the kiosk RPC handlers resolve when the
 * device runtime invokes them (i.e. via the authenticated procedures, where the
 * `isRealDevice()` gate lives — the kiosk module functions themselves are
 * ungated):
 *
 *   1. dev  (shouldUseMocks() → true): the toggle handlers run against the
 *      in-memory `createMockKioskDeps()` harness — so kioskStart/kioskStop/
 *      kioskConfigure are exercisable on a dev box with NO board / systemctl /
 *      systemd-sysext, mutating + broadcasting through the harness recorder
 *      instead of returning `kiosk_unavailable_in_emulated_mode`.
 *   2. prod-real  (NODE_ENV=production + CERALIVE_DEVICE_TYPE=real): the real
 *      systemd/marker probe surface is used and the mock double factory is
 *      NEVER called.
 *   3. prod-emulated  (NODE_ENV=production + CERALIVE_DEVICE_TYPE=emulated):
 *      shouldUseMocks() is false, no mock double is constructed, and the
 *      EXISTING `kiosk_unavailable_in_emulated_mode` gate still fires.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	KIOSK_CRASH_LOOP_RESTART_THRESHOLD,
	KIOSK_UNAVAILABLE_ERROR,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getActiveMockKioskHarness } from "../mocks/providers/kiosk.ts";
import { getConfig } from "../modules/config.ts";
import {
	peekMockKioskHarness,
	pollKioskOnce,
	resetKioskDeps,
	resolveActiveKioskDeps,
	setKioskDeps,
	stopKioskPolling,
} from "../modules/system/kiosk.ts";
import {
	kioskConfigureProcedure,
	kioskStartProcedure,
	kioskStopProcedure,
} from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// Snapshot the env knobs the three-way split reads so each test can flip them
// and the suite leaves the process exactly as it found it (other test files in
// the same `bun test` process must keep seeing shouldUseMocks() === false).
const ORIGINAL_ENV = {
	NODE_ENV: process.env.NODE_ENV,
	MOCK_MODE: process.env.MOCK_MODE,
	CERALIVE_DEVICE_TYPE: process.env.CERALIVE_DEVICE_TYPE,
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
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

function resetKioskConfig(): void {
	const config = getConfig();
	config.kiosk_enabled = false;
	config.kiosk_last_state = "disabled";
	config.kiosk_display = "lcd";
	config.kiosk_touch = true;
	config.kiosk_motion = true;
	config.kiosk_performance = "balanced";
}

/** Enter dev mock mode: development env + an initialised mock service. */
function enterDevMockMode(): void {
	process.env.NODE_ENV = "development";
	delete process.env.MOCK_MODE;
	delete process.env.CERALIVE_DEVICE_TYPE;
	initMockService("multi-modem-wifi");
}

/** Drain the fire-and-forget async tail of a kiosk toggle (the add-on enable). */
async function flushAsyncTail(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	stopKioskPolling();
	resetKioskConfig();
	resetKioskDeps();
});

afterEach(() => {
	stopKioskPolling();
	stopMockService();
	resetKioskDeps();
	restoreEnv();
});

// ─── dev: handlers run against the in-memory harness ─────────────────────────

describe("kiosk (dev / shouldUseMocks) — toggles hit the in-memory harness", () => {
	test("kioskStart succeeds, broadcasts status, and merges the cog-display sysext on the harness", async () => {
		enterDevMockMode();

		const result = await call(kioskStartProcedure, undefined, {
			context: makeContext(),
		});

		// The emulated dev gate is bypassed — the toggle ran, not unavailable.
		expect(result).toEqual({
			success: true,
			applied: { enabled: true, state: "enabled-stopped" },
		});

		const harness = peekMockKioskHarness();
		expect(harness).not.toBeNull();
		// It is the SAME harness the provider registered as active.
		expect(harness).toBe(getActiveMockKioskHarness());

		// The synchronous prelude already broadcast the committed enabled-stopped.
		expect(harness?.broadcasts.length).toBeGreaterThan(0);
		expect(harness?.broadcasts.at(-1)?.enabled).toBe(true);

		// Let the fire-and-forget add-on enable settle, then assert the store was
		// actually MUTATED (sysext merged) — not merely a success return value.
		await flushAsyncTail();
		expect(harness?.enableAddonCalls).toHaveLength(1);
		expect(harness?.isSysextMerged()).toBe(true);

		stopKioskPolling();
	});

	test("kioskStop succeeds and unmerges the sysext on the SAME harness", async () => {
		enterDevMockMode();

		await call(kioskStartProcedure, undefined, { context: makeContext() });
		await flushAsyncTail();
		const harness = peekMockKioskHarness();
		expect(harness?.isSysextMerged()).toBe(true);

		const result = await call(kioskStopProcedure, undefined, {
			context: makeContext(),
		});

		expect(result).toEqual({
			success: true,
			applied: { enabled: false, state: "disabled" },
		});
		// start + stop shared ONE harness singleton.
		expect(peekMockKioskHarness()).toBe(harness);

		await flushAsyncTail();
		expect(harness?.disableAddonCalls).toHaveLength(1);
		expect(harness?.isSysextMerged()).toBe(false);
		expect(getConfig().kiosk_enabled).toBe(false);

		stopKioskPolling();
	});

	test("kioskConfigure succeeds and broadcasts the persisted profile", async () => {
		enterDevMockMode();

		const result = await call(
			kioskConfigureProcedure,
			{ display: "mono", touch: false, motion: false, performance: "high" },
			{ context: makeContext() },
		);

		expect(result).toEqual({
			success: true,
			applied: {
				display: "mono",
				touch: false,
				motion: false,
				performance: "high",
			},
		});

		// kioskConfigure is synchronous — the broadcast already landed on the mock.
		const harness = peekMockKioskHarness();
		expect(harness).not.toBeNull();
		expect(harness?.broadcasts.at(-1)).toMatchObject({
			display: "mono",
			touch: false,
			motion: false,
			performance: "high",
		});
		// The profile was actually persisted (a real config mutation, not a stub).
		expect(getConfig().kiosk_display).toBe("mono");
	});
});

// ─── prod-real: real runner invoked, mock double NEVER constructed ───────────

describe("kiosk (prod-real) — real runner invoked, no mock double", () => {
	test("the real systemctl runner masks the unit and no mock harness is built", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		process.env.CERALIVE_DEVICE_TYPE = "real";

		// Arm a crash-loop so a single poll drives the auto-disable mask through
		// the REAL (injected) systemctl runner. CERALIVE_DEVICE_TYPE=real keeps
		// shouldUseMocks() false, so resolveActiveKioskDeps() returns activeDeps.
		getConfig().kiosk_enabled = true;
		const systemctlCalls: string[][] = [];
		setKioskDeps({
			systemctl: async (args) => {
				systemctlCalls.push([...args]);
				return { stdout: "", stderr: "" };
			},
			isFailed: async () => true,
			isActive: async () => false,
			getNRestarts: async () => KIOSK_CRASH_LOOP_RESTART_THRESHOLD,
			noDisplayMarkerExists: async () => false,
			broadcast: () => {},
		});

		const deps = resolveActiveKioskDeps();
		await pollKioskOnce(deps);

		// The real systemctl runner masked the unit exactly once (auto-disable).
		expect(systemctlCalls).toEqual([["mask", "kiosk.service"]]);
		// The mock double factory was NEVER called on the production path.
		expect(peekMockKioskHarness()).toBeNull();
	});
});

// ─── prod-emulated: existing kiosk_unavailable gate still fires ──────────────

describe("kiosk (prod-emulated) — kiosk_unavailable gate still fires", () => {
	test("kioskStart returns kiosk_unavailable and constructs no mock double", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		process.env.CERALIVE_DEVICE_TYPE = "emulated";

		const result = await call(kioskStartProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe(KIOSK_UNAVAILABLE_ERROR);
		expect(result.applied).toBeUndefined();
		// Gate fired first: no mock double, no real systemd reached.
		expect(peekMockKioskHarness()).toBeNull();
		expect(getConfig().kiosk_enabled).toBe(false);
	});

	test("kioskConfigure returns kiosk_unavailable and persists nothing", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		process.env.CERALIVE_DEVICE_TYPE = "emulated";

		const result = await call(
			kioskConfigureProcedure,
			{ display: "eink", touch: false, motion: false, performance: "low" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe(KIOSK_UNAVAILABLE_ERROR);
		expect(result.applied).toBeUndefined();
		expect(peekMockKioskHarness()).toBeNull();
		expect(getConfig().kiosk_display).toBe("lcd");
	});
});
