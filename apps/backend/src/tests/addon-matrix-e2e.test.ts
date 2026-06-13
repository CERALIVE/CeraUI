/*
 * Tier-4 add-on compatibility matrix — synthetic-fixture E2E.
 *
 * Proves the full compatibility contract end-to-end against three ON-DISK
 * synthetic descriptors that live OUTSIDE the real discovery path:
 *
 *   apps/backend/tests/fixtures/addons/
 *     ├── test-addon-a.json   compatibleHardware: ['rk3588']   (board gate)
 *     ├── test-addon-b.json   deps: ['test-addon-c']           (dependency)
 *     └── test-addon-c.json   conflicts: ['test-addon-b']      (conflict pair)
 *
 * Two layers are exercised together so the assertion chain is genuinely
 * end-to-end, not a unit slice:
 *
 *   - SERVER GATE — the real RPC handlers (`installAddonProcedure`,
 *     `uninstallAddonProcedure`) drive the real manager state machine
 *     (`enableAddon`/`disableAddon`) through its injected `AddonManagerDeps`.
 *     The board gate (T23 hardware ∩ deps ∩ conflicts) is enforced exactly as
 *     it is on a device — no shortcut helper is called directly.
 *   - UI REFLECTION — after every transition the test calls the same read-only
 *     `listAddonsProcedure` the Add-ons settings surface calls
 *     (`AddonsSection.svelte` → `rpc.addons.list()`), then derives the rendered
 *     badge with a faithful mirror of that component's own
 *     `phaseFromState` → `PHASE_META.label` map. The badge a user would see is
 *     asserted for each cell of the matrix.
 *
 * Isolation guarantee: the fixtures are injected via the procedure's
 * `readDescriptors` dep; the real device discovery path
 * (`/usr/share/ceralive/addons`, addons.procedure.ts → readBakedDescriptors)
 * never sees them. The final describe block proves that explicitly.
 *
 * No board, sudo, network, or disk write is touched: every OS-facing manager
 * primitive is a spy, and the descriptors are read from the repo-local fixtures.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type AddonDescriptor,
	AddonDescriptorSchema,
	type AddonState,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import {
	type AddonHardware,
	type AddonManagerDeps,
	type AddonManagerPhase,
	getAddonPhase,
	initAddonManager,
	phaseFromState,
	resetAddonManagerDeps,
	setAddonManagerDeps,
} from "../modules/addons/manager.ts";
import {
	installAddonProcedure,
	listAddonsProcedure,
	resetAddonProcedureDeps,
	setAddonProcedureDeps,
	uninstallAddonProcedure,
} from "../rpc/procedures/addons.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// ─── synthetic fixtures (on disk, outside the real discovery path) ───────────

/** The image-baked descriptor drop dir the real device discovery scans. The
 *  constant is private to addons.procedure.ts (ADDON_DESCRIPTOR_DIR); mirrored
 *  here ONLY to assert the fixtures never live under it. */
const DISCOVERY_DIR = "/usr/share/ceralive/addons";
/** Repo-local synthetic-fixture dir — deliberately NOT the discovery dir. */
const FIXTURE_DIR = join(import.meta.dir, "../../tests/fixtures/addons");
const FIXTURE_IDS = ["test-addon-a", "test-addon-b", "test-addon-c"] as const;

async function loadFixture(id: string): Promise<AddonDescriptor> {
	const raw = await Bun.file(join(FIXTURE_DIR, `${id}.json`)).json();
	// Parse through the same schema the device uses, so a malformed fixture
	// fails loudly here rather than masquerading as a passing matrix.
	return AddonDescriptorSchema.parse(raw);
}

async function loadFixtures(): Promise<AddonDescriptor[]> {
	return Promise.all(FIXTURE_IDS.map(loadFixture));
}

// ─── UI reflection mirror (AddonsSection.svelte) ─────────────────────────────

/** The exact badge label AddonsSection.svelte renders per manager phase
 *  (PHASE_META[...].label). Kept in lockstep with the component so this E2E
 *  asserts what a user actually sees. */
const UI_BADGE_LABEL: Record<AddonManagerPhase, string> = {
	disabled: "Disabled",
	pending: "Update pending",
	enabling: "Installing",
	enabled: "Enabled",
	disabling: "Removing",
	failed: "Failed",
	auto_disabled: "Auto-disabled",
};

/** Reproduce what the Add-ons card would render for one add-on, straight from
 *  the listAddons() output (descriptor + state) the component consumes. */
function uiBadge(state: AddonState): string {
	return UI_BADGE_LABEL[phaseFromState(state)];
}

// ─── harness ─────────────────────────────────────────────────────────────────

type World = {
	store: Map<string, AddonState>;
	context: RPCContext;
};

/** Wire the real RPC procedures + real manager to a single shared add-on store
 *  and a fixed effective board. Every OS-facing manager primitive is a healthy
 *  spy, so `enableAddon` runs its full ordered pipeline without a device. */
function makeWorld(board: AddonHardware): World {
	const store = new Map<string, AddonState>();

	const managerDeps: AddonManagerDeps = {
		isRealDevice: () => Promise.resolve(true),
		getEffectiveHardware: () => board,
		getDataFreeBytes: () => Promise.resolve(100 * 1024 * 1024 * 1024),
		getOsVersion: () => Promise.resolve("12"),
		download: () => Promise.resolve(),
		verify: () => Promise.resolve(),
		stage: () => Promise.resolve(),
		helperEnable: () => Promise.resolve(),
		helperDisable: () => Promise.resolve(),
		systemctl: () => Promise.resolve({ stdout: "", stderr: "" }),
		getNRestarts: () => Promise.resolve(0),
		runValidate: () => Promise.resolve(true),
		removeArtifact: () => Promise.resolve(),
		getState: (id) => store.get(id),
		setState: (id, state) => {
			store.set(id, state);
		},
		removeState: (id) => {
			store.delete(id);
		},
		broadcast: () => {},
	};
	setAddonManagerDeps(managerDeps);

	setAddonProcedureDeps({
		isRealDevice: () => Promise.resolve(true),
		getEffectiveHardware: () => board,
		readDescriptors: loadFixtures,
		// Read/write the SAME store the manager mutates, so the procedure-level
		// compat gate and listAddons reflect live enable/disable transitions.
		getAddonState: (id) => store.get(id),
		setAddonState: (id, state) => {
			store.set(id, state);
		},
	});

	const context = makeContext();
	return { store, context };
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

type InstallResult =
	| { success: true; phase: AddonManagerPhase }
	| { success: false; error: string };

function install(world: World, id: string): Promise<InstallResult> {
	return call(installAddonProcedure, { id }, { context: world.context });
}

function uninstall(world: World, id: string): Promise<InstallResult> {
	return call(uninstallAddonProcedure, { id }, { context: world.context });
}

/** The card a user would see for `id`, derived from the same list() the UI uses. */
async function uiCard(
	world: World,
	id: string,
): Promise<{ phase: AddonManagerPhase; badge: string; enabled: boolean }> {
	const { addons } = await call(listAddonsProcedure, undefined, {
		context: world.context,
	});
	const item = addons.find((a) => a.descriptor.id === id);
	if (!item) throw new Error(`add-on ${id} missing from listAddons output`);
	return {
		phase: item.managerPhase,
		badge: uiBadge(item.state),
		enabled: item.state.enabled,
	};
}

beforeEach(() => {
	resetAddonManagerDeps();
	resetAddonProcedureDeps();
	initAddonManager();
});

afterEach(() => {
	resetAddonManagerDeps();
	resetAddonProcedureDeps();
});

// ─── matrix: board gate ──────────────────────────────────────────────────────

describe("Tier-4 matrix — board gating (test-addon-a, rk3588-only)", () => {
	test("blocked on an incompatible board; UI badge stays Disabled", async () => {
		const world = makeWorld("n100");

		const result = await install(world, "test-addon-a");

		expect(result).toEqual({
			success: false,
			error: "addon_incompatible_hardware",
		});
		// Server side: never enabled.
		expect(getAddonPhase("test-addon-a")).toBe("disabled");
		// UI reflection: card renders the Disabled badge, toggle off.
		const card = await uiCard(world, "test-addon-a");
		expect(card.phase).toBe("disabled");
		expect(card.badge).toBe("Disabled");
		expect(card.enabled).toBe(false);
	});

	test("enables on the compatible board; UI badge flips to Enabled", async () => {
		const world = makeWorld("rk3588");

		const result = await install(world, "test-addon-a");

		expect(result).toEqual({ success: true, phase: "enabled" });
		expect(getAddonPhase("test-addon-a")).toBe("enabled");
		const card = await uiCard(world, "test-addon-a");
		expect(card.phase).toBe("enabled");
		expect(card.badge).toBe("Enabled");
		expect(card.enabled).toBe(true);
	});
});

// ─── matrix: dependency chain ────────────────────────────────────────────────

describe("Tier-4 matrix — dependency chain (test-addon-b ⇒ test-addon-c)", () => {
	test("blocked while the dependency is disabled, then enables once it is on", async () => {
		const world = makeWorld("rk3588");

		// 1. Dependency missing — b refuses, UI stays Disabled.
		const blocked = await install(world, "test-addon-b");
		expect(blocked).toEqual({
			success: false,
			error: "addon_dependency_missing",
		});
		expect((await uiCard(world, "test-addon-b")).badge).toBe("Disabled");

		// 2. Bring the dependency up (c has no conflict yet — b is still off).
		const depOn = await install(world, "test-addon-c");
		expect(depOn).toEqual({ success: true, phase: "enabled" });
		expect((await uiCard(world, "test-addon-c")).badge).toBe("Enabled");

		// 3. Dependency satisfied — b now enables, UI flips to Enabled.
		const ok = await install(world, "test-addon-b");
		expect(ok).toEqual({ success: true, phase: "enabled" });
		const card = await uiCard(world, "test-addon-b");
		expect(card.phase).toBe("enabled");
		expect(card.badge).toBe("Enabled");
	});
});

// ─── matrix: conflict blocking ───────────────────────────────────────────────

describe("Tier-4 matrix — conflict blocking (test-addon-c ⇎ test-addon-b)", () => {
	test("with the conflicting add-on enabled, the other is refused; UI stays Disabled", async () => {
		const world = makeWorld("rk3588");

		// Reach a state where test-addon-b is enabled (via its dependency on c).
		expect((await install(world, "test-addon-c")).success).toBe(true);
		expect((await install(world, "test-addon-b")).success).toBe(true);

		// Take the dependency back down so it can be re-attempted independently.
		expect((await uninstall(world, "test-addon-c")).success).toBe(true);
		expect((await uiCard(world, "test-addon-c")).badge).toBe("Disabled");

		// test-addon-b is now enabled; c declares it as a conflict → refused.
		const conflict = await install(world, "test-addon-c");
		expect(conflict).toEqual({ success: false, error: "addon_conflict" });
		expect(getAddonPhase("test-addon-c")).toBe("disabled");
		const card = await uiCard(world, "test-addon-c");
		expect(card.phase).toBe("disabled");
		expect(card.badge).toBe("Disabled");
	});
});

// ─── matrix: all three behaviours in one end-to-end run ──────────────────────

describe("Tier-4 matrix — board gate + dep chain + conflict, end-to-end", () => {
	test("a single rk3588 session walks every gate and list() reflects each cell", async () => {
		const world = makeWorld("rk3588");

		// Board gate (positive cell): rk3588-only add-on enables here.
		expect((await install(world, "test-addon-a")).success).toBe(true);
		expect((await uiCard(world, "test-addon-a")).badge).toBe("Enabled");

		// Dependency gate: b blocked, then allowed after c.
		expect((await install(world, "test-addon-b")).error).toBe(
			"addon_dependency_missing",
		);
		expect((await install(world, "test-addon-c")).success).toBe(true);
		expect((await install(world, "test-addon-b")).success).toBe(true);

		// Conflict gate: c back down, then refused while b is enabled.
		expect((await uninstall(world, "test-addon-c")).success).toBe(true);
		expect((await install(world, "test-addon-c")).error).toBe("addon_conflict");

		// Final UI snapshot of the whole catalogue.
		const { addons } = await call(listAddonsProcedure, undefined, {
			context: world.context,
		});
		const badges = Object.fromEntries(
			addons.map((a) => [a.descriptor.id, uiBadge(a.state)]),
		);
		expect(badges).toEqual({
			"test-addon-a": "Enabled",
			"test-addon-b": "Enabled",
			"test-addon-c": "Disabled",
		});
	});
});

// ─── isolation: the synthetic fixtures are never in the real discovery path ──

describe("synthetic fixture isolation — never in the real addon discovery path", () => {
	test("every synthetic fixture is a schema-valid AddonDescriptor", async () => {
		const descriptors = await loadFixtures();
		expect(descriptors.map((d) => d.id)).toEqual([...FIXTURE_IDS]);
		// Confirms each fixture exercises exactly one Tier-4 axis.
		const byId = Object.fromEntries(descriptors.map((d) => [d.id, d]));
		expect(byId["test-addon-a"]?.compatibleHardware).toEqual(["rk3588"]);
		expect(byId["test-addon-b"]?.deps).toEqual(["test-addon-c"]);
		expect(byId["test-addon-c"]?.conflicts).toEqual(["test-addon-b"]);
	});

	test("the fixture directory lives outside the device discovery directory", () => {
		// The reconciler/procedure scan /usr/share/ceralive/addons; the fixtures
		// resolve under the repo's tests/ tree and never below the discovery dir.
		expect(FIXTURE_DIR.startsWith(DISCOVERY_DIR)).toBe(false);
		expect(FIXTURE_DIR).toContain(
			join("apps", "backend", "tests", "fixtures", "addons"),
		);
	});

	test("the real (default) addon discovery never lists any synthetic fixture id", async () => {
		// Default deps read the baked descriptors off /usr/share/ceralive/addons.
		// On any host without the synthetic fixtures installed there (i.e. every
		// host — they only exist under tests/), none of the ids can appear.
		resetAddonProcedureDeps();
		const context = makeContext();

		const { addons } = await call(listAddonsProcedure, undefined, { context });
		const discoveredIds = new Set(addons.map((a) => a.descriptor.id));
		for (const id of FIXTURE_IDS) {
			expect(discoveredIds.has(id)).toBe(false);
		}
	});
});
