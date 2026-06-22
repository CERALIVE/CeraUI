/*
 * T7 — dev-parity for the add-on subsystem.
 *
 * Proves the three-way dependency split the manager + reconciler resolve when a
 * public op is invoked WITHOUT explicit deps (i.e. how the device runtime calls
 * them):
 *
 *   1. dev  (shouldUseMocks() → true): enable/disable/poll + the reconciler run
 *      against the in-memory `createMock*Deps()` harness — so the whole add-on
 *      flow is exercisable on a dev box with NO board / sudo / systemctl / disk
 *      / network, mutating the harness store rather than returning
 *      `addon_unavailable_in_emulated_mode`.
 *   2. prod-real  (NODE_ENV=production + CERALIVE_DEVICE_TYPE=real): the real
 *      device primitives are used and the mock double factory is NEVER called.
 *   3. prod-emulated  (NODE_ENV=production + CERALIVE_DEVICE_TYPE=emulated):
 *      shouldUseMocks() is false, no mock double is constructed, and the
 *      EXISTING `addon_unavailable_in_emulated_mode` G6 gate still fires.
 *
 * The prod paths are asserted WITHOUT running the real enable pipeline (which
 * would touch the network / sysext scan dir): we inspect the resolved deps and
 * the gate outcome, both of which short-circuit before any I/O.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AddonStateSchema } from "@ceraui/rpc/schemas";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import {
	MOCK_ADDON_UNIT,
	MockAddonDescriptor,
} from "../mocks/providers/addons.ts";
import {
	ADDON_UNAVAILABLE_ERROR,
	disableAddon,
	enableAddon,
	getAddonPhase,
	initAddonManager,
	peekMockAddonManagerHarness,
	resetAddonManagerDeps,
	resolveActiveAddonManagerDeps,
} from "../modules/addons/manager.ts";
import {
	peekMockReconcilerHarness,
	resetAddonReconcilerMock,
	runAddonReconciler,
} from "../modules/addons/reconciler.ts";

const ID = MockAddonDescriptor.id;

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

/** Enter dev mock mode: development env + an initialised mock service. */
function enterDevMockMode(): void {
	process.env.NODE_ENV = "development";
	delete process.env.MOCK_MODE;
	delete process.env.CERALIVE_DEVICE_TYPE;
	initMockService("multi-modem-wifi");
}

beforeEach(() => {
	resetAddonManagerDeps();
	resetAddonReconcilerMock();
	initAddonManager();
});

afterEach(() => {
	stopMockService();
	resetAddonManagerDeps();
	resetAddonReconcilerMock();
	restoreEnv();
});

// ─── dev: manager runs against the in-memory harness ─────────────────────────

describe("manager (dev / shouldUseMocks) — enable/disable hit the harness", () => {
	test("enableAddon succeeds, mutates the harness store, and records ordered ops", async () => {
		enterDevMockMode();

		const result = await enableAddon(MockAddonDescriptor);

		expect(result).toEqual({ success: true, phase: "enabled" });
		expect(getAddonPhase(ID)).toBe("enabled");

		// The op ran against the lazily-built dev harness, not the real deps.
		const harness = peekMockAddonManagerHarness();
		expect(harness).not.toBeNull();

		// The store was actually MUTATED — not just a success return value.
		const persisted = harness?.store.get(ID);
		expect(AddonStateSchema.safeParse(persisted).success).toBe(true);
		expect(persisted?.phase).toBe("active");
		expect(persisted?.enabled).toBe(true);
		expect(persisted?.versionMaterialized).toBe(MockAddonDescriptor.version);

		// The full enable pipeline ran in order against the fakes.
		expect(harness?.rec.order).toEqual([
			"download",
			"verify",
			"stage",
			"helperEnable",
			`systemctl:unmask ${MOCK_ADDON_UNIT}`,
			`systemctl:start ${MOCK_ADDON_UNIT}`,
			"validate",
		]);
		expect(harness?.rec.helperEnable).toEqual([ID]);
	});

	test("disableAddon tears the add-on back down on the SAME harness", async () => {
		enterDevMockMode();

		await enableAddon(MockAddonDescriptor);
		const harness = peekMockAddonManagerHarness();
		expect(harness?.store.has(ID)).toBe(true);

		const result = await disableAddon(MockAddonDescriptor);

		expect(result).toEqual({ success: true, phase: "disabled" });
		expect(getAddonPhase(ID)).toBe("disabled");
		// enable + disable shared one harness singleton — the store dropped the id.
		expect(peekMockAddonManagerHarness()).toBe(harness);
		expect(harness?.store.has(ID)).toBe(false);
		expect(harness?.rec.helperDisable).toEqual([ID]);
		expect(harness?.rec.removeState).toContain(ID);
	});
});

// ─── dev: reconciler runs as a controlled harness pass ───────────────────────

describe("reconciler (dev / shouldUseMocks) — controlled harness pass", () => {
	test("runAddonReconciler materialises the seeded add-on on the fake surface", async () => {
		enterDevMockMode();

		await runAddonReconciler();

		const harness = peekMockReconcilerHarness();
		expect(harness).not.toBeNull();
		// A real-device-shaped pass (not the emulated skip): the seeded add-on is
		// (re)materialised against the fakes — fetch + refresh + an active write.
		expect(harness?.rec.fetch).toHaveLength(1);
		expect(harness?.rec.refresh).toBe(1);
		expect(harness?.rec.states.at(-1)?.state.phase).toBe("active");
	});
});

// ─── prod-real: real deps, mock double NEVER constructed ─────────────────────

describe("manager (prod-real) — real deps, no mock double", () => {
	test("resolves the real device primitives without constructing a mock harness", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		process.env.CERALIVE_DEVICE_TYPE = "real";

		const deps = resolveActiveAddonManagerDeps();

		// CERALIVE_DEVICE_TYPE=real short-circuits isRealDevice() before any file
		// read, so this is the real device-detection primitive — and it says real.
		expect(await deps.isRealDevice()).toBe(true);
		// The mock double factory was NEVER called on the production path.
		expect(peekMockAddonManagerHarness()).toBeNull();
	});
});

// ─── prod-emulated: existing addon_unavailable gate still fires ──────────────

describe("manager (prod-emulated) — addon_unavailable gate still fires", () => {
	test("enable/disable return addon_unavailable and construct no mock double", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		process.env.CERALIVE_DEVICE_TYPE = "emulated";

		const enableResult = await enableAddon(MockAddonDescriptor);
		expect(enableResult).toEqual({
			success: false,
			error: ADDON_UNAVAILABLE_ERROR,
		});

		const disableResult = await disableAddon(MockAddonDescriptor);
		expect(disableResult).toEqual({
			success: false,
			error: ADDON_UNAVAILABLE_ERROR,
		});

		// No mock double was constructed, and no real helper/systemd was reached
		// (the G6 gate fires first), so nothing materialised.
		expect(peekMockAddonManagerHarness()).toBeNull();
		expect(getAddonPhase(ID)).toBe("disabled");
	});

	test("reconciler hits the existing emulated skip and builds no mock double", async () => {
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		process.env.CERALIVE_DEVICE_TYPE = "emulated";

		await runAddonReconciler();

		// Real deps were resolved (shouldUseMocks() false), isRealDevice() → false
		// → the existing emulated-skip path; no mock double was constructed.
		expect(peekMockReconcilerHarness()).toBeNull();
	});
});
