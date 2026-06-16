import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KIOSK_UNAVAILABLE_ERROR } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import {
	mockKioskTokenSchema,
	validateMockFixtures,
} from "../mocks/mock-schemas.ts";
import {
	createMockKioskDeps,
	generateMockKioskToken,
	getActiveMockKioskHarness,
	getMockKioskStatus,
	MOCK_COG_DISPLAY_DESCRIPTOR,
	MOCK_KIOSK_STATUS,
	MOCK_KIOSK_TOKEN,
	resetMockKioskState,
} from "../mocks/providers/kiosk.ts";
import { getConfig } from "../modules/config.ts";
import {
	getKioskLiveState,
	initKiosk,
	kioskConfigure,
	kioskStart,
	kioskStop,
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

let savedDeviceType: string | undefined;

beforeEach(() => {
	stopKioskPolling();
	resetKioskConfig();
	initKiosk(createMockKioskDeps().deps);
	savedDeviceType = process.env.CERALIVE_DEVICE_TYPE;
});

afterEach(() => {
	stopKioskPolling();
	resetKioskDeps();
	resetMockKioskState();
	if (savedDeviceType === undefined) delete process.env.CERALIVE_DEVICE_TYPE;
	else process.env.CERALIVE_DEVICE_TYPE = savedDeviceType;
});

describe("kiosk fixtures validate (Task 3 wiring)", () => {
	test("validateMockFixtures accepts the kiosk token/status/descriptor fixtures", () => {
		expect(() => validateMockFixtures()).not.toThrow();
	});

	test("MOCK_KIOSK_TOKEN matches the 64-hex token grammar", () => {
		expect(mockKioskTokenSchema.safeParse(MOCK_KIOSK_TOKEN).success).toBe(true);
	});

	test("generateMockKioskToken mints a fresh, schema-valid 64-hex token", () => {
		const a = generateMockKioskToken();
		const b = generateMockKioskToken();
		expect(a).toHaveLength(64);
		expect(mockKioskTokenSchema.safeParse(a).success).toBe(true);
		expect(a).not.toBe(b);
	});

	test("a malformed kiosk token is rejected", () => {
		expect(mockKioskTokenSchema.safeParse("not-a-token").success).toBe(false);
		expect(mockKioskTokenSchema.safeParse("ABCD".repeat(16)).success).toBe(
			false,
		);
	});

	test("getMockKioskStatus returns a defensive copy of the pristine fixture", () => {
		const status = getMockKioskStatus();
		expect(status).toEqual(MOCK_KIOSK_STATUS);
		expect(status).not.toBe(MOCK_KIOSK_STATUS);
	});
});

describe("kiosk mock double drives the DC-2 module (real-device branch)", () => {
	test("kioskStart enables the cog-display add-on and merges the sysext", async () => {
		const h = createMockKioskDeps();
		setKioskDeps(h.deps);

		const status = await kioskStart(h.deps);

		expect(status.state).toBe("enabled-stopped");
		expect(getKioskLiveState()).toBe("enabled-stopped");
		expect(getConfig().kiosk_enabled).toBe(true);
		expect(h.enableAddonCalls).toContainEqual(MOCK_COG_DISPLAY_DESCRIPTOR);
		expect(h.sysextOps).toEqual(["merge"]);
		expect(h.isSysextMerged()).toBe(true);

		stopKioskPolling();
	});

	test("after start a poll resolves enabled-running off the faked unit state", async () => {
		const h = createMockKioskDeps();
		setKioskDeps(h.deps);
		await kioskStart(h.deps);

		expect(await pollKioskOnce(h.deps)).toBe("enabled-running");
		expect(getKioskLiveState()).toBe("enabled-running");

		stopKioskPolling();
	});

	test("kioskStop disables the add-on, unmerges the sysext, removes the marker", async () => {
		const h = createMockKioskDeps({ isActive: true });
		getConfig().kiosk_enabled = true;
		setKioskDeps(h.deps);

		const status = await kioskStop(h.deps);

		expect(status.state).toBe("disabled");
		expect(getKioskLiveState()).toBe("disabled");
		expect(getConfig().kiosk_enabled).toBe(false);
		expect(h.disableAddonCalls).toContainEqual(MOCK_COG_DISPLAY_DESCRIPTOR);
		expect(h.sysextOps).toEqual(["unmerge"]);
		expect(h.isSysextMerged()).toBe(false);
		expect(h.markerRemovedCount()).toBeGreaterThanOrEqual(1);
	});

	test("kioskConfigure persists the display profile and broadcasts", () => {
		const h = createMockKioskDeps();
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
		expect(getConfig().kiosk_display).toBe("eink");
		expect(h.broadcasts[h.broadcasts.length - 1]?.display).toBe("eink");
	});
});

describe("kiosk RPC handlers — real-device branch", () => {
	beforeEach(() => {
		process.env.CERALIVE_DEVICE_TYPE = "real";
	});

	test("kioskStart commits the toggle and enables the add-on", async () => {
		const h = createMockKioskDeps();
		setKioskDeps(h.deps);

		const result = await call(kioskStartProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(result.applied?.enabled).toBe(true);
		expect(result.applied?.state).toBe("enabled-stopped");
		expect(h.enableAddonCalls).toContainEqual(MOCK_COG_DISPLAY_DESCRIPTOR);
		expect(h.sysextOps).toEqual(["merge"]);

		stopKioskPolling();
	});

	test("kioskStop commits disabled and disables the add-on", async () => {
		const h = createMockKioskDeps({ isActive: true });
		getConfig().kiosk_enabled = true;
		setKioskDeps(h.deps);

		const result = await call(kioskStopProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(true);
		expect(result.applied?.enabled).toBe(false);
		expect(result.applied?.state).toBe("disabled");
		expect(h.disableAddonCalls).toContainEqual(MOCK_COG_DISPLAY_DESCRIPTOR);
		expect(h.sysextOps).toEqual(["unmerge"]);
	});

	test("kioskConfigure persists via RPC and echoes applied", async () => {
		const h = createMockKioskDeps();
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
});

describe("kiosk RPC handlers — emulated-mode gated no-op", () => {
	beforeEach(() => {
		process.env.CERALIVE_DEVICE_TYPE = "emulated";
	});

	test("kioskStart is unavailable and never touches the mock double", async () => {
		const h = createMockKioskDeps();
		setKioskDeps(h.deps);

		const result = await call(kioskStartProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe(KIOSK_UNAVAILABLE_ERROR);
		expect(result.applied).toBeUndefined();
		expect(h.systemctlCalls).toHaveLength(0);
		expect(h.enableAddonCalls).toHaveLength(0);
		expect(h.sysextOps).toHaveLength(0);
		expect(getConfig().kiosk_enabled).toBe(false);
	});

	test("kioskStop is unavailable and never disables the add-on", async () => {
		const h = createMockKioskDeps();
		setKioskDeps(h.deps);

		const result = await call(kioskStopProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe(KIOSK_UNAVAILABLE_ERROR);
		expect(result.applied).toBeUndefined();
		expect(h.disableAddonCalls).toHaveLength(0);
		expect(h.sysextOps).toHaveLength(0);
	});

	test("kioskConfigure is unavailable and never persists or broadcasts", async () => {
		const h = createMockKioskDeps();
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

	test("kioskOsk is unavailable and never signals the keyboard", async () => {
		const h = createMockKioskDeps();
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

describe("kioskStatus is ungated (read-only)", () => {
	test("returns the persisted toggle + live state even in emulated mode", async () => {
		process.env.CERALIVE_DEVICE_TYPE = "emulated";
		setKioskDeps(createMockKioskDeps().deps);

		const result = await call(kioskStatusProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.enabled).toBe(false);
		expect(result.state).toBe("disabled");
		expect(result.display).toBe("lcd");
	});
});

describe("resetMockKioskState scrubs the active harness (Task 4 wiring)", () => {
	test("getActiveMockKioskHarness tracks the most recent harness", () => {
		const h = createMockKioskDeps();
		expect(getActiveMockKioskHarness()).toBe(h);
	});

	test("reset clears recorders and restores the initial signals/sysext state", async () => {
		process.env.CERALIVE_DEVICE_TYPE = "real";
		const h = createMockKioskDeps();
		setKioskDeps(h.deps);
		await kioskStart(h.deps);
		stopKioskPolling();

		expect(h.enableAddonCalls.length).toBeGreaterThan(0);
		expect(h.sysextOps.length).toBeGreaterThan(0);
		expect(h.isSysextMerged()).toBe(true);

		resetMockKioskState();

		expect(h.enableAddonCalls).toHaveLength(0);
		expect(h.disableAddonCalls).toHaveLength(0);
		expect(h.systemctlCalls).toHaveLength(0);
		expect(h.broadcasts).toHaveLength(0);
		expect(h.sysextOps).toHaveLength(0);
		expect(h.isSysextMerged()).toBe(false);
		expect(h.signals.isActive).toBe(false);
	});
});
