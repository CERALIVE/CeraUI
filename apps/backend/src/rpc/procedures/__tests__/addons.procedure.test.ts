/*
 * Task 30 — add-on RPC procedures (rpc/procedures/addons.procedure.ts).
 *
 * The read-only handlers (`list`, `getStatus`) merge the image-baked descriptors
 * with the manager's live phase + persisted state and are NOT gated; the three
 * mutating handlers gate on isRealDevice() (G6) and drive the device only
 * through the manager. The descriptor disk read is injected via the procedure's
 * `AddonProcedureDeps`; the enable/disable pipeline is exercised against a real
 * manager wired to a spy `AddonManagerDeps` (mirrors tests/manager.test.ts), so
 * the suite never needs a board, sudo, or network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AddonDescriptor, AddonState } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import {
	type AddonManagerDeps,
	getAddonPhase,
	initAddonManager,
	resetAddonManagerDeps,
	setAddonManagerDeps,
} from "../../../modules/addons/manager.ts";
import { ADDON_EVENT } from "../../events.ts";
import type { AppWebSocket, RPCContext } from "../../types.ts";
import {
	ADDON_NOT_FOUND_ERROR,
	configureAddonProcedure,
	getAddonStatusProcedure,
	installAddonProcedure,
	listAddonsProcedure,
	resetAddonProcedureDeps,
	setAddonProcedureDeps,
	uninstallAddonProcedure,
} from "../addons.procedure.ts";

const ADDON_UNAVAILABLE = "addon_unavailable_in_emulated_mode";
const UNIT = "debug-toolset.service";

function makeDescriptor(over: Partial<AddonDescriptor> = {}): AddonDescriptor {
	return {
		id: "debug-toolset",
		name: "Debug Toolset",
		version: "1.2.3",
		category: "debug",
		payload: { type: "sysext" },
		sysextLevel: "1",
		versionId: "12",
		artifact: {
			urlTemplate:
				"https://apt.ceralive.tv/addons/debug-toolset/{os_version}/debug-toolset.raw",
			sha256: "a".repeat(64),
			gpgSigRef:
				"https://apt.ceralive.tv/addons/debug-toolset/{os_version}/debug-toolset.raw.sig",
			sizeDownload: 1024,
			sizeInstalled: 4096,
		},
		provides: ["/usr/bin/debug-toolset"],
		units: { unmask: [UNIT], enable: [UNIT], start: [UNIT] },
		validate: { cmd: "test -x /usr/bin/debug-toolset" },
		...over,
	};
}

type ManagerHarness = {
	deps: AddonManagerDeps;
	store: Map<string, AddonState>;
	broadcasts: Array<{ id: string; state: AddonState }>;
	helperEnable: string[];
	helperDisable: string[];
	removeState: string[];
};

function makeManagerHarness(): ManagerHarness {
	const store = new Map<string, AddonState>();
	const broadcasts: Array<{ id: string; state: AddonState }> = [];
	const helperEnable: string[] = [];
	const helperDisable: string[] = [];
	const removeState: string[] = [];

	const deps: AddonManagerDeps = {
		isRealDevice: () => Promise.resolve(true),
		getEffectiveHardware: () => "rk3588",
		getDataFreeBytes: () => Promise.resolve(100 * 1024 * 1024 * 1024),
		getOsVersion: () => Promise.resolve("12"),
		download: () => Promise.resolve(),
		verify: () => Promise.resolve(),
		stage: () => Promise.resolve(),
		helperEnable: (id) => {
			helperEnable.push(id);
			return Promise.resolve();
		},
		helperDisable: (id) => {
			helperDisable.push(id);
			return Promise.resolve();
		},
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
			removeState.push(id);
		},
		broadcast: (id, state) => {
			broadcasts.push({ id, state });
		},
	};

	return { deps, store, broadcasts, helperEnable, helperDisable, removeState };
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

beforeEach(() => {
	resetAddonManagerDeps();
	resetAddonProcedureDeps();
	initAddonManager();
});

afterEach(() => {
	resetAddonManagerDeps();
	resetAddonProcedureDeps();
});

describe("addons.list (read-only, not gated)", () => {
	test("returns each descriptor merged with its persisted state + live phase", async () => {
		const descriptor = makeDescriptor();
		const state: AddonState = {
			enabled: true,
			phase: "active",
			autoDisabled: false,
			versionMaterialized: "1.2.3",
		};
		setAddonProcedureDeps({
			readDescriptors: () => Promise.resolve([descriptor]),
			getAddonState: () => state,
			getAddonPhase: () => "enabled",
		});

		const result = await call(listAddonsProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.addons).toHaveLength(1);
		expect(result.addons[0]?.descriptor.id).toBe("debug-toolset");
		expect(result.addons[0]?.state).toEqual(state);
		expect(result.addons[0]?.managerPhase).toBe("enabled");
	});

	test("still returns data in emulated mode (NOT gated)", async () => {
		const descriptor = makeDescriptor();
		setAddonProcedureDeps({
			readDescriptors: () => Promise.resolve([descriptor]),
			isRealDevice: () => Promise.resolve(false),
		});

		const result = await call(listAddonsProcedure, undefined, {
			context: makeContext(),
		});

		expect(result.addons).toHaveLength(1);
		expect(result.addons[0]?.descriptor.id).toBe("debug-toolset");
	});
});

describe("addons.getStatus (read-only, not gated)", () => {
	test("surfaces the descriptor's disk-size impact + live state", async () => {
		const descriptor = makeDescriptor();
		setAddonProcedureDeps({
			readDescriptors: () => Promise.resolve([descriptor]),
		});

		const result = await call(
			getAddonStatusProcedure,
			{ id: "debug-toolset" },
			{ context: makeContext() },
		);

		expect(result?.descriptor.artifact.sizeInstalled).toBe(4096);
		expect(result?.descriptor.artifact.sizeDownload).toBe(1024);
		expect(result?.managerPhase).toBe("disabled");
	});

	test("resolves null for an unknown id", async () => {
		setAddonProcedureDeps({ readDescriptors: () => Promise.resolve([]) });

		const result = await call(
			getAddonStatusProcedure,
			{ id: "nope" },
			{ context: makeContext() },
		);

		expect(result).toBeNull();
	});
});

describe("addons.install (gated on isRealDevice, drives the manager)", () => {
	test("transitions the add-on to enabled and emits addons broadcasts", async () => {
		const h = makeManagerHarness();
		setAddonManagerDeps(h.deps);
		const descriptor = makeDescriptor();
		setAddonProcedureDeps({
			isRealDevice: () => Promise.resolve(true),
			readDescriptors: () => Promise.resolve([descriptor]),
		});

		const result = await call(
			installAddonProcedure,
			{ id: "debug-toolset" },
			{ context: makeContext() },
		);

		expect(result).toEqual({ success: true, phase: "enabled" });
		expect(getAddonPhase("debug-toolset")).toBe("enabled");
		expect(h.helperEnable).toEqual(["debug-toolset"]);
		// The `addons` channel is the manager broadcast surface (single source).
		expect(ADDON_EVENT).toBe("addons");
		expect(h.broadcasts.map((b) => b.state.phase)).toEqual([
			"installing",
			"active",
		]);
		expect(h.broadcasts.at(-1)?.state.enabled).toBe(true);
	});

	test("returns addon_unavailable in emulated mode and never touches the manager", async () => {
		const h = makeManagerHarness();
		setAddonManagerDeps(h.deps);
		const descriptor = makeDescriptor();
		setAddonProcedureDeps({
			isRealDevice: () => Promise.resolve(false),
			readDescriptors: () => Promise.resolve([descriptor]),
		});

		const result = await call(
			installAddonProcedure,
			{ id: "debug-toolset" },
			{ context: makeContext() },
		);

		expect(result).toEqual({ success: false, error: ADDON_UNAVAILABLE });
		expect(h.helperEnable).toHaveLength(0);
		expect(h.broadcasts).toHaveLength(0);
		expect(getAddonPhase("debug-toolset")).toBe("disabled");
	});

	test("returns addon_not_found for an id with no descriptor", async () => {
		setAddonProcedureDeps({
			isRealDevice: () => Promise.resolve(true),
			readDescriptors: () => Promise.resolve([]),
		});

		const result = await call(
			installAddonProcedure,
			{ id: "ghost-addon" },
			{ context: makeContext() },
		);

		expect(result).toEqual({ success: false, error: ADDON_NOT_FOUND_ERROR });
	});

	test("rejects an install whose compatibleHardware excludes the board", async () => {
		const h = makeManagerHarness();
		setAddonManagerDeps(h.deps);
		const descriptor = makeDescriptor({ compatibleHardware: ["jetson"] });
		const saved: Array<{ id: string; state: AddonState }> = [];
		setAddonProcedureDeps({
			isRealDevice: () => Promise.resolve(true),
			getEffectiveHardware: () => "n100",
			readDescriptors: () => Promise.resolve([descriptor]),
			setAddonState: (id, state) => {
				saved.push({ id, state });
			},
		});

		const result = await call(
			installAddonProcedure,
			{ id: "debug-toolset", userConfig: { verbose: true } },
			{ context: makeContext() },
		);

		expect(result).toEqual({
			success: false,
			error: "addon_incompatible_hardware",
		});
		// Rejected before persisting userConfig or driving the manager.
		expect(saved).toHaveLength(0);
		expect(h.helperEnable).toHaveLength(0);
		expect(getAddonPhase("debug-toolset")).toBe("disabled");
	});
});

describe("addons.uninstall (gated on isRealDevice, reverses install)", () => {
	test("disables the add-on and tears down its persisted state", async () => {
		const h = makeManagerHarness();
		setAddonManagerDeps(h.deps);
		const descriptor = makeDescriptor();
		setAddonProcedureDeps({
			isRealDevice: () => Promise.resolve(true),
			readDescriptors: () => Promise.resolve([descriptor]),
		});

		await call(
			installAddonProcedure,
			{ id: "debug-toolset" },
			{ context: makeContext() },
		);
		expect(getAddonPhase("debug-toolset")).toBe("enabled");

		const result = await call(
			uninstallAddonProcedure,
			{ id: "debug-toolset" },
			{ context: makeContext() },
		);

		expect(result).toEqual({ success: true, phase: "disabled" });
		expect(getAddonPhase("debug-toolset")).toBe("disabled");
		expect(h.helperDisable).toEqual(["debug-toolset"]);
		expect(h.removeState).toContain("debug-toolset");
	});

	test("returns addon_unavailable in emulated mode", async () => {
		const h = makeManagerHarness();
		setAddonManagerDeps(h.deps);
		const descriptor = makeDescriptor();
		setAddonProcedureDeps({
			isRealDevice: () => Promise.resolve(false),
			readDescriptors: () => Promise.resolve([descriptor]),
		});

		const result = await call(
			uninstallAddonProcedure,
			{ id: "debug-toolset" },
			{ context: makeContext() },
		);

		expect(result).toEqual({ success: false, error: ADDON_UNAVAILABLE });
		expect(h.helperDisable).toHaveLength(0);
	});
});

describe("addons.configure (gated on isRealDevice)", () => {
	test("persists userConfig onto the existing state", async () => {
		const existing: AddonState = {
			enabled: true,
			phase: "active",
			autoDisabled: false,
		};
		const saved: Array<{ id: string; state: AddonState }> = [];
		setAddonProcedureDeps({
			isRealDevice: () => Promise.resolve(true),
			getAddonState: () => existing,
			setAddonState: (id, state) => {
				saved.push({ id, state });
			},
		});

		const result = await call(
			configureAddonProcedure,
			{ id: "debug-toolset", fields: { verbose: true } },
			{ context: makeContext() },
		);

		expect(result).toEqual({ success: true, applied: { verbose: true } });
		expect(saved[0]?.state.userConfig).toEqual({ verbose: true });
		expect(saved[0]?.state.enabled).toBe(true);
	});

	test("returns addon_unavailable in emulated mode", async () => {
		setAddonProcedureDeps({ isRealDevice: () => Promise.resolve(false) });

		const result = await call(
			configureAddonProcedure,
			{ id: "debug-toolset", fields: { verbose: true } },
			{ context: makeContext() },
		);

		expect(result).toEqual({ success: false, error: ADDON_UNAVAILABLE });
	});
});

describe("addons procedures reject an unauthenticated caller", () => {
	test("list rejects without auth", async () => {
		await expect(
			call(listAddonsProcedure, undefined, { context: makeContext(false) }),
		).rejects.toThrow();
	});
});
