/*
 * Task 13 — add-on subsystem mocks (descriptor / state / manager / reconciler).
 *
 * Proves the shipped fixtures + dependency doubles in mocks/providers/addons.ts
 * let the REAL manager and reconciler be exercised end to end with zero board,
 * sudo, systemctl, disk, or network:
 *
 *   - the fixtures validate against the real @ceraui/rpc Zod schemas;
 *   - enable → active and disable → idle run purely on the faked
 *     helper/systemctl/fs surface;
 *   - the crash-loop auto-disable path runs on mocks;
 *   - both the manager and the reconciler no-op in emulated mode;
 *   - the seeded addon slot is restored by resetMockState().
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

import { AddonDescriptorSchema, AddonStateSchema } from "@ceraui/rpc/schemas";

import {
	getMockAddons,
	initMockService,
	resetMockState,
	setMockAddonState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	createMockAddonManagerDeps,
	createMockReconcilerDeps,
	MOCK_ADDON_UNIT,
	MockAddonDescriptor,
	MockAddonState,
} from "../mocks/providers/addons.ts";
import {
	ADDON_CRASH_LOOP_REASON,
	ADDON_CRASH_LOOP_RESTART_THRESHOLD,
	ADDON_UNAVAILABLE_ERROR,
	disableAddon,
	enableAddon,
	getAddonPhase,
	initAddonManager,
	pollAddonCrashLoop,
	resetAddonManagerDeps,
} from "../modules/addons/manager.ts";
import { runAddonReconciler } from "../modules/addons/reconciler.ts";

const ID = MockAddonDescriptor.id;

beforeEach(() => {
	resetAddonManagerDeps();
	// Clears the module-level live-phase map so getAddonPhase starts clean.
	initAddonManager();
});

afterEach(() => {
	resetAddonManagerDeps();
});

// ─── fixtures validate against the real schemas ──────────────────────────────

describe("addon fixtures — schema-valid against @ceraui/rpc", () => {
	test("MockAddonDescriptor validates against AddonDescriptorSchema", () => {
		const result = AddonDescriptorSchema.safeParse(MockAddonDescriptor);
		expect(result.success).toBe(true);
	});

	test("MockAddonState validates against AddonStateSchema", () => {
		const result = AddonStateSchema.safeParse(MockAddonState);
		expect(result.success).toBe(true);
	});
});

// ─── enable → active on mocks ────────────────────────────────────────────────

describe("manager enable happy path — purely on mocks", () => {
	test("enable transitions the add-on to active via faked helper + systemctl", async () => {
		const { deps, store, rec } = createMockAddonManagerDeps();

		const result = await enableAddon(MockAddonDescriptor, deps);

		expect(result).toEqual({ success: true, phase: "enabled" });
		expect(getAddonPhase(ID)).toBe("enabled");

		// Persisted state is schema-valid and records active + materialised version.
		const persisted = store.get(ID);
		expect(AddonStateSchema.safeParse(persisted).success).toBe(true);
		expect(persisted?.phase).toBe("active");
		expect(persisted?.enabled).toBe(true);
		expect(persisted?.versionMaterialized).toBe(MockAddonDescriptor.version);

		// The pipeline ran against the injected fakes — no real helper/systemctl.
		expect(rec.helperEnable).toEqual([ID]);
		expect(rec.systemctl).toContainEqual(["unmask", MOCK_ADDON_UNIT]);
		expect(rec.systemctl).toContainEqual(["start", MOCK_ADDON_UNIT]);
		expect(rec.runValidate).toEqual([MockAddonDescriptor.validate.cmd]);
		expect(rec.download).toHaveLength(1);
	});
});

// ─── disable → idle on mocks ─────────────────────────────────────────────────

describe("manager disable happy path — purely on mocks", () => {
	test("disable tears down via faked helper + systemctl and broadcasts idle", async () => {
		const { deps, store, rec } = createMockAddonManagerDeps();
		await enableAddon(MockAddonDescriptor, deps);

		rec.broadcast.length = 0;
		const result = await disableAddon(MockAddonDescriptor, deps);

		expect(result).toEqual({ success: true, phase: "disabled" });
		expect(getAddonPhase(ID)).toBe("disabled");

		// The disabled add-on broadcasts an idle AddonState, then state is dropped.
		const finalBroadcast = rec.broadcast[rec.broadcast.length - 1];
		expect(finalBroadcast?.state.phase).toBe("idle");
		expect(finalBroadcast?.state.enabled).toBe(false);
		expect(store.has(ID)).toBe(false);

		expect(rec.helperDisable).toEqual([ID]);
		expect(rec.systemctl).toContainEqual(["stop", MOCK_ADDON_UNIT]);
		expect(rec.removeState).toContain(ID);
	});
});

// ─── crash-loop auto-disable on mocks ────────────────────────────────────────

describe("manager crash-loop auto-disable — purely on mocks", () => {
	test("a crash-looping unit masks the unit and parks the add-on auto_disabled", async () => {
		const harness = createMockAddonManagerDeps();
		const { deps, store, rec } = harness;
		await enableAddon(MockAddonDescriptor, deps);
		expect(getAddonPhase(ID)).toBe("enabled");

		harness.signals.nRestarts = ADDON_CRASH_LOOP_RESTART_THRESHOLD;
		rec.systemctl.length = 0;
		const phase = await pollAddonCrashLoop(MockAddonDescriptor, deps);

		expect(phase).toBe("auto_disabled");
		expect(getAddonPhase(ID)).toBe("auto_disabled");
		expect(store.get(ID)?.autoDisabled).toBe(true);
		expect(store.get(ID)?.lastError).toBe(ADDON_CRASH_LOOP_REASON);
		expect(rec.systemctl).toContainEqual(["mask", MOCK_ADDON_UNIT]);
	});
});

// ─── emulated-mode no-op (manager + reconciler) ──────────────────────────────

describe("manager — emulated-mode no-op", () => {
	test("enable/disable return addon_unavailable and touch nothing", async () => {
		const { deps, rec } = createMockAddonManagerDeps({ isRealDevice: false });

		const enableResult = await enableAddon(MockAddonDescriptor, deps);
		expect(enableResult).toEqual({
			success: false,
			error: ADDON_UNAVAILABLE_ERROR,
		});
		expect(rec.download).toHaveLength(0);
		expect(rec.setState).toHaveLength(0);
		expect(rec.systemctl).toHaveLength(0);
		expect(getAddonPhase(ID)).toBe("disabled");

		const disableResult = await disableAddon(MockAddonDescriptor, deps);
		expect(disableResult).toEqual({
			success: false,
			error: ADDON_UNAVAILABLE_ERROR,
		});
		expect(rec.helperDisable).toHaveLength(0);
	});
});

describe("reconciler — emulated-mode no-op", () => {
	test("never reads OS version, fetches, refreshes, or writes state", async () => {
		let osRead = false;
		const { deps, rec } = createMockReconcilerDeps(
			{ isRealDevice: false, rawExists: false },
			{
				getOsVersionId: () => {
					osRead = true;
					return Promise.resolve("12");
				},
			},
		);

		await runAddonReconciler(deps);

		expect(osRead).toBe(false);
		expect(rec.states).toHaveLength(0);
		expect(rec.fetch).toHaveLength(0);
		expect(rec.refresh).toBe(0);
	});
});

// ─── reconciler happy paths on mocks ─────────────────────────────────────────

describe("reconciler — re-materialise vs idempotent no-op on mocks", () => {
	test("re-materialises an enabled add-on when the staged .raw is missing", async () => {
		const { deps, rec } = createMockReconcilerDeps({ rawExists: false });

		await runAddonReconciler(deps);

		expect(rec.fetch).toHaveLength(1);
		expect(rec.refresh).toBe(1);
		const final = rec.states[rec.states.length - 1]?.state;
		expect(final?.phase).toBe("active");
		expect(final?.osVersionMaterialized).toBe("12");
		expect(final?.versionMaterialized).toBe(MockAddonDescriptor.version);
	});

	test("is an idempotent no-op when already materialised for the live OS", async () => {
		const { deps, rec } = createMockReconcilerDeps({ rawExists: true });

		await runAddonReconciler(deps);

		expect(rec.fetch).toHaveLength(0);
		expect(rec.refresh).toBe(0);
		expect(rec.states).toHaveLength(0);
	});
});

// ─── mockState wiring — seed + reset ─────────────────────────────────────────

describe("addon mock state — seeded into mockState + restored by resetMockState", () => {
	beforeAll(() => initMockService("multi-modem-wifi"));
	afterAll(() => stopMockService());

	test("initMockService seeds the MockAddonState fixture", () => {
		expect(getMockAddons()[ID]).toEqual(MockAddonState);
	});

	test("resetMockState restores a polluted addon slot", () => {
		setMockAddonState(ID, {
			enabled: false,
			phase: "error",
			autoDisabled: true,
			lastError: "polluted",
		});
		expect(getMockAddons()[ID]?.phase).toBe("error");

		resetMockState();

		expect(getMockAddons()[ID]).toEqual(MockAddonState);
	});
});
