/*
 * Task 28 — add-on manager state machine (modules/addons/manager.ts).
 *
 * Covers the orchestration the manager owns, with every OS/network/persistence
 * primitive injected through `AddonManagerDeps` (mirrors the kiosk-rpc suite):
 *
 *   - the pure layer: phase ⇄ AddonState mapping (always schema-valid), the E1
 *     free-space formula, the crash-loop discriminator, url/df parsing;
 *   - the enable pipeline: ordered steps + phase transitions → enabled;
 *   - the disable pipeline: reverse + idempotent;
 *   - crash-loop auto-disable (NRestarts >= 3 → mask + auto_disabled);
 *   - the validation-probe auto-disable;
 *   - the negative paths: G6 emulated-mode gate + E1 insufficient space.
 *
 * No real sudo / systemctl / network / disk is touched, and the injected
 * setState/removeState spies keep config.json out of the test entirely.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type AddonDescriptor,
	type AddonPhase,
	type AddonState,
	AddonStateSchema,
} from "@ceraui/rpc/schemas";

import {
	ADDON_CONFLICT_ERROR,
	ADDON_CRASH_LOOP_RESTART_THRESHOLD,
	ADDON_DEPENDENCY_MISSING_ERROR,
	ADDON_ENABLE_FAILED_ERROR,
	ADDON_FREE_SPACE_HEADROOM_BYTES,
	ADDON_INCOMPATIBLE_HARDWARE_ERROR,
	ADDON_INSUFFICIENT_SPACE_ERROR,
	ADDON_MANAGER_PHASES,
	ADDON_UNAVAILABLE_ERROR,
	ADDON_VALIDATION_FAILED_ERROR,
	type AddonHardware,
	type AddonManagerDeps,
	type AddonManagerPhase,
	disableAddon,
	enableAddon,
	extArtifactPath,
	getAddonPhase,
	hasSufficientSpace,
	initAddonManager,
	isAddonCrashLoop,
	parseDfAvail,
	phaseFromState,
	pollAddonCrashLoop,
	requiredFreeBytes,
	resetAddonManagerDeps,
	resolveArtifactUrl,
	tmpArtifactPath,
	toAddonState,
} from "../modules/addons/manager.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const UNIT = "debug-toolset.service";

/** A fully-formed, schema-valid descriptor (overridable per test). */
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

type Signals = {
	isRealDevice: boolean;
	hardware: AddonHardware;
	freeBytes: number;
	nRestarts: number;
	validateOk: boolean;
};

type Recorded = {
	setState: Array<{
		id: string;
		persistedPhase: AddonPhase;
		mgr: AddonManagerPhase;
	}>;
	broadcast: Array<{ id: string; state: AddonState }>;
	systemctl: string[][];
	download: Array<{ url: string; dest: string }>;
	verify: string[];
	stage: Array<{ tmp: string; dest: string }>;
	helperEnable: string[];
	helperDisable: string[];
	removeArtifact: string[];
	removeState: string[];
	runValidate: string[];
	/** Chronological op log for ordering assertions. */
	order: string[];
};

type Harness = {
	deps: AddonManagerDeps;
	signals: Signals;
	store: Map<string, AddonState>;
	rec: Recorded;
};

/** A spying dep surface: real-device + plenty of space + healthy probe by default. */
function makeHarness(
	signalsOver: Partial<Signals> = {},
	over: Partial<AddonManagerDeps> = {},
): Harness {
	const signals: Signals = {
		isRealDevice: true,
		hardware: "rk3588",
		freeBytes: 100 * 1024 * 1024 * 1024, // 100 GiB — never the limiting factor
		nRestarts: 0,
		validateOk: true,
		...signalsOver,
	};
	const store = new Map<string, AddonState>();
	const rec: Recorded = {
		setState: [],
		broadcast: [],
		systemctl: [],
		download: [],
		verify: [],
		stage: [],
		helperEnable: [],
		helperDisable: [],
		removeArtifact: [],
		removeState: [],
		runValidate: [],
		order: [],
	};

	const deps: AddonManagerDeps = {
		isRealDevice: () => Promise.resolve(signals.isRealDevice),
		getEffectiveHardware: () => signals.hardware,
		getDataFreeBytes: () => Promise.resolve(signals.freeBytes),
		getOsVersion: () => Promise.resolve("12"),
		download: (url, dest) => {
			rec.download.push({ url, dest });
			rec.order.push("download");
			return Promise.resolve();
		},
		verify: (_d, tmp) => {
			rec.verify.push(tmp);
			rec.order.push("verify");
			return Promise.resolve();
		},
		stage: (tmp, dest) => {
			rec.stage.push({ tmp, dest });
			rec.order.push("stage");
			return Promise.resolve();
		},
		helperEnable: (id) => {
			rec.helperEnable.push(id);
			rec.order.push("helperEnable");
			return Promise.resolve();
		},
		helperDisable: (id) => {
			rec.helperDisable.push(id);
			rec.order.push("helperDisable");
			return Promise.resolve();
		},
		systemctl: (args) => {
			rec.systemctl.push(args);
			rec.order.push(`systemctl:${args.join(" ")}`);
			return Promise.resolve({ stdout: "", stderr: "" });
		},
		getNRestarts: () => Promise.resolve(signals.nRestarts),
		runValidate: (cmd) => {
			rec.runValidate.push(cmd);
			rec.order.push("validate");
			return Promise.resolve(signals.validateOk);
		},
		removeArtifact: (path) => {
			rec.removeArtifact.push(path);
			return Promise.resolve();
		},
		getState: (id) => store.get(id),
		setState: (id, state) => {
			store.set(id, state);
			rec.setState.push({
				id,
				persistedPhase: state.phase,
				mgr: phaseFromState(state),
			});
		},
		removeState: (id) => {
			store.delete(id);
			rec.removeState.push(id);
		},
		broadcast: (id, state) => {
			rec.broadcast.push({ id, state });
		},
		...over,
	};

	return { deps, signals, store, rec };
}

beforeEach(() => {
	resetAddonManagerDeps();
	// Clears the module-level live-phase map (config is empty in tests).
	initAddonManager();
});

afterEach(() => {
	resetAddonManagerDeps();
});

// ─── pure layer ──────────────────────────────────────────────────────────────

describe("phase ⇄ AddonState mapping", () => {
	test("every manager phase encodes a schema-valid AddonState", () => {
		for (const phase of ADDON_MANAGER_PHASES) {
			const state = toAddonState(phase);
			expect(AddonStateSchema.safeParse(state).success).toBe(true);
		}
	});

	test("phaseFromState is the exact inverse of toAddonState", () => {
		for (const phase of ADDON_MANAGER_PHASES) {
			expect(phaseFromState(toAddonState(phase))).toBe(phase);
		}
	});

	test("optional metadata is attached only when supplied", () => {
		const bare = toAddonState("enabled");
		expect(bare).toEqual({
			enabled: true,
			phase: "active",
			autoDisabled: false,
		});

		const rich = toAddonState("enabled", {
			versionMaterialized: "1.2.3",
			userConfig: { theme: "dark" },
		});
		expect(rich.versionMaterialized).toBe("1.2.3");
		expect(rich.userConfig).toEqual({ theme: "dark" });
		expect(rich.lastError).toBeUndefined();
	});
});

describe("free-space precheck (E1)", () => {
	test("requiredFreeBytes = sizeInstalled × 2 + 512 MiB headroom", () => {
		expect(requiredFreeBytes(4096)).toBe(
			4096 * 2 + ADDON_FREE_SPACE_HEADROOM_BYTES,
		);
		expect(ADDON_FREE_SPACE_HEADROOM_BYTES).toBe(512 * 1024 * 1024);
	});

	test("hasSufficientSpace is strict (must exceed the requirement)", () => {
		const need = requiredFreeBytes(4096);
		expect(hasSufficientSpace(need + 1, 4096)).toBe(true);
		expect(hasSufficientSpace(need, 4096)).toBe(false);
		expect(hasSufficientSpace(need - 1, 4096)).toBe(false);
	});
});

describe("crash-loop discriminator", () => {
	test("true at/above the threshold, false below", () => {
		expect(ADDON_CRASH_LOOP_RESTART_THRESHOLD).toBe(3);
		expect(isAddonCrashLoop(2)).toBe(false);
		expect(isAddonCrashLoop(3)).toBe(true);
		expect(isAddonCrashLoop(9)).toBe(true);
	});
});

describe("url + df parsing", () => {
	test("resolveArtifactUrl substitutes every {os_version}", () => {
		expect(
			resolveArtifactUrl("https://x/{os_version}/a/{os_version}.raw", "12"),
		).toBe("https://x/12/a/12.raw");
	});

	test("parseDfAvail reads the avail column of df -B1 --output=avail", () => {
		expect(parseDfAvail("Avail\n  10737418240\n")).toBe(10737418240);
		expect(parseDfAvail("garbage")).toBeNull();
	});
});

// ─── enable pipeline ─────────────────────────────────────────────────────────

describe("enableAddon — happy path", () => {
	test("runs the pipeline in order and transitions enabling → enabled", async () => {
		const h = makeHarness();
		const d = makeDescriptor();

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({ success: true, phase: "enabled" });
		expect(getAddonPhase(d.id)).toBe("enabled");

		// Phase transitions persisted in order: installing (enabling) → active (enabled).
		expect(h.rec.setState.map((s) => s.mgr)).toEqual(["enabling", "enabled"]);
		expect(h.rec.setState.map((s) => s.persistedPhase)).toEqual([
			"installing",
			"active",
		]);
		// Final persisted state records the materialised version.
		expect(h.store.get(d.id)?.versionMaterialized).toBe("1.2.3");
		expect(h.store.get(d.id)?.enabled).toBe(true);

		// Pipeline targets the atomic temp + scan-dir paths.
		expect(h.rec.download[0]?.dest).toBe(tmpArtifactPath(d.id));
		expect(h.rec.download[0]?.url).toBe(
			"https://apt.ceralive.tv/addons/debug-toolset/12/debug-toolset.raw",
		);
		expect(h.rec.stage[0]).toEqual({
			tmp: tmpArtifactPath(d.id),
			dest: extArtifactPath(d.id),
		});
		expect(h.rec.helperEnable).toEqual([d.id]);

		// Strict ordering: download → verify → stage → helper enable → unmask →
		// start → validate.
		const o = h.rec.order;
		const idx = (tag: string) => o.indexOf(tag);
		expect(idx("download")).toBeLessThan(idx("verify"));
		expect(idx("verify")).toBeLessThan(idx("stage"));
		expect(idx("stage")).toBeLessThan(idx("helperEnable"));
		expect(idx("helperEnable")).toBeLessThan(idx(`systemctl:unmask ${UNIT}`));
		expect(idx(`systemctl:unmask ${UNIT}`)).toBeLessThan(
			idx(`systemctl:start ${UNIT}`),
		);
		expect(idx(`systemctl:start ${UNIT}`)).toBeLessThan(idx("validate"));
	});

	test("an enable-step failure parks the add-on in failed and cleans the temp", async () => {
		const h = makeHarness(
			{},
			{
				helperEnable: () => Promise.reject(new Error("sudo denied")),
			},
		);
		const d = makeDescriptor();

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({
			success: false,
			error: ADDON_ENABLE_FAILED_ERROR,
		});
		expect(getAddonPhase(d.id)).toBe("failed");
		expect(h.store.get(d.id)?.phase).toBe("error");
		expect(h.store.get(d.id)?.lastError).toContain("sudo denied");
		// The partial download was removed.
		expect(h.rec.removeArtifact).toContain(tmpArtifactPath(d.id));
	});
});

describe("enableAddon — validation probe auto-disable", () => {
	test("a failing probe masks units and parks the add-on in auto_disabled", async () => {
		const h = makeHarness({ validateOk: false });
		const d = makeDescriptor();

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({
			success: false,
			error: ADDON_VALIDATION_FAILED_ERROR,
		});
		expect(getAddonPhase(d.id)).toBe("auto_disabled");
		expect(h.store.get(d.id)?.autoDisabled).toBe(true);
		expect(h.rec.systemctl).toContainEqual(["mask", UNIT]);
	});
});

// ─── disable pipeline ────────────────────────────────────────────────────────

describe("disableAddon — reverse + idempotent", () => {
	test("stops + masks units, tears down via helper, removes artifact + state", async () => {
		const h = makeHarness();
		const d = makeDescriptor();
		await enableAddon(d, h.deps);

		// Isolate the disable systemctl traffic from the enable run.
		h.rec.systemctl.length = 0;
		const result = await disableAddon(d, h.deps);

		expect(result).toEqual({ success: true, phase: "disabled" });
		expect(getAddonPhase(d.id)).toBe("disabled");
		expect(h.rec.systemctl).toContainEqual(["stop", UNIT]);
		expect(h.rec.systemctl).toContainEqual(["mask", UNIT]);
		expect(h.rec.helperDisable).toEqual([d.id]);
		expect(h.rec.removeArtifact).toContain(extArtifactPath(d.id));
		expect(h.rec.removeState).toContain(d.id);
		// Device-local state was dropped.
		expect(h.store.has(d.id)).toBe(false);
	});

	test("a second disable on an already-disabled add-on is a harmless no-op", async () => {
		const h = makeHarness();
		const d = makeDescriptor();
		await enableAddon(d, h.deps);

		expect((await disableAddon(d, h.deps)).success).toBe(true);
		expect((await disableAddon(d, h.deps)).success).toBe(true);
		expect(getAddonPhase(d.id)).toBe("disabled");
	});
});

// ─── crash-loop auto-disable ─────────────────────────────────────────────────

describe("pollAddonCrashLoop — NRestarts >= 3 auto-disable", () => {
	test("a crash-looping unit is masked and the add-on goes auto_disabled", async () => {
		const h = makeHarness();
		const d = makeDescriptor();
		await enableAddon(d, h.deps);
		expect(getAddonPhase(d.id)).toBe("enabled");

		h.signals.nRestarts = ADDON_CRASH_LOOP_RESTART_THRESHOLD;
		h.rec.systemctl.length = 0;
		const phase = await pollAddonCrashLoop(d, h.deps);

		expect(phase).toBe("auto_disabled");
		expect(getAddonPhase(d.id)).toBe("auto_disabled");
		expect(h.store.get(d.id)?.autoDisabled).toBe(true);
		expect(h.store.get(d.id)?.lastError).toBe("addon_crash_loop");
		expect(h.rec.systemctl).toContainEqual(["mask", UNIT]);
	});

	test("below the threshold the add-on stays enabled and nothing is masked", async () => {
		const h = makeHarness();
		const d = makeDescriptor();
		await enableAddon(d, h.deps);

		h.signals.nRestarts = ADDON_CRASH_LOOP_RESTART_THRESHOLD - 1;
		h.rec.systemctl.length = 0;
		const phase = await pollAddonCrashLoop(d, h.deps);

		expect(phase).toBe("enabled");
		expect(getAddonPhase(d.id)).toBe("enabled");
		expect(h.rec.systemctl).not.toContainEqual(["mask", UNIT]);
	});

	test("a non-enabled add-on is never crash-loop-disabled", async () => {
		const h = makeHarness({ nRestarts: 9 });
		const d = makeDescriptor();
		// Never enabled — phase is the default `disabled`.
		const phase = await pollAddonCrashLoop(d, h.deps);
		expect(phase).toBe("disabled");
		expect(h.rec.systemctl).toHaveLength(0);
	});
});

// ─── negative paths (G6 emulated gate + E1 insufficient space) ───────────────

describe("enableAddon — negative: G6 emulated-mode gate", () => {
	test("emulated mode returns addon_unavailable and touches nothing", async () => {
		const h = makeHarness({ isRealDevice: false });
		const d = makeDescriptor();

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({ success: false, error: ADDON_UNAVAILABLE_ERROR });
		// No download, no transition, no systemd — the gate fires first.
		expect(h.rec.download).toHaveLength(0);
		expect(h.rec.setState).toHaveLength(0);
		expect(h.rec.systemctl).toHaveLength(0);
		expect(getAddonPhase(d.id)).toBe("disabled");
	});
});

describe("disableAddon — negative: G6 emulated-mode gate", () => {
	test("emulated mode returns addon_unavailable and never tears down", async () => {
		const h = makeHarness({ isRealDevice: false });
		const d = makeDescriptor();

		const result = await disableAddon(d, h.deps);

		expect(result).toEqual({ success: false, error: ADDON_UNAVAILABLE_ERROR });
		expect(h.rec.systemctl).toHaveLength(0);
		expect(h.rec.helperDisable).toHaveLength(0);
		expect(h.rec.setState).toHaveLength(0);
	});
});

describe("pollAddonCrashLoop — negative: G6 emulated-mode gate", () => {
	test("emulated mode never probes NRestarts or masks", async () => {
		const h = makeHarness({ isRealDevice: false, nRestarts: 9 });
		const d = makeDescriptor();

		const phase = await pollAddonCrashLoop(d, h.deps);

		expect(phase).toBe("disabled");
		expect(h.rec.systemctl).toHaveLength(0);
	});
});

describe("enableAddon — negative: E1 insufficient space", () => {
	test("too little free /data returns addon_insufficient_space before any work", async () => {
		const d = makeDescriptor();
		// One byte short of the requirement.
		const need = requiredFreeBytes(d.artifact.sizeInstalled);
		const h = makeHarness({ freeBytes: need });

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({
			success: false,
			error: ADDON_INSUFFICIENT_SPACE_ERROR,
		});
		// Precheck fires before the first transition or download.
		expect(h.rec.setState).toHaveLength(0);
		expect(h.rec.download).toHaveLength(0);
		expect(getAddonPhase(d.id)).toBe("disabled");
	});
});

// ─── compatibility gate (T23: hardware ∩ deps ∩ conflicts) ───────────────────

describe("enableAddon — compatibility gate (T23)", () => {
	test("rejects when compatibleHardware excludes the effective board", async () => {
		const h = makeHarness({ hardware: "n100" });
		const d = makeDescriptor({ compatibleHardware: ["jetson"] });

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({
			success: false,
			error: ADDON_INCOMPATIBLE_HARDWARE_ERROR,
		});
		// Gate fires before any state mutation or download.
		expect(h.rec.setState).toHaveLength(0);
		expect(h.rec.download).toHaveLength(0);
		expect(getAddonPhase(d.id)).toBe("disabled");
	});

	test("proceeds when compatibleHardware includes the effective board", async () => {
		const h = makeHarness({ hardware: "n100" });
		const d = makeDescriptor({ compatibleHardware: ["n100", "generic"] });

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({ success: true, phase: "enabled" });
		expect(getAddonPhase(d.id)).toBe("enabled");
	});

	test("absent compatibleHardware is treated as all-hardware", async () => {
		const h = makeHarness({ hardware: "jetson" });
		const d = makeDescriptor();

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({ success: true, phase: "enabled" });
	});

	test("rejects when a declared dependency is not enabled", async () => {
		const h = makeHarness();
		const d = makeDescriptor({ id: "needs-dep", deps: ["debug-toolset"] });

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({
			success: false,
			error: ADDON_DEPENDENCY_MISSING_ERROR,
		});
		expect(h.rec.download).toHaveLength(0);
		expect(getAddonPhase(d.id)).toBe("disabled");
	});

	test("proceeds once every declared dependency is enabled", async () => {
		const h = makeHarness();
		// Bring the dependency fully active in the shared store first.
		await enableAddon(makeDescriptor({ id: "debug-toolset" }), h.deps);

		const dependent = makeDescriptor({
			id: "needs-dep",
			deps: ["debug-toolset"],
			units: { start: ["needs-dep.service"] },
		});
		const result = await enableAddon(dependent, h.deps);

		expect(result).toEqual({ success: true, phase: "enabled" });
	});

	test("rejects when a conflicting add-on is currently enabled", async () => {
		const h = makeHarness();
		await enableAddon(makeDescriptor({ id: "addon-a" }), h.deps);

		const conflicting = makeDescriptor({
			id: "addon-b",
			conflicts: ["addon-a"],
			units: { start: ["addon-b.service"] },
		});
		const result = await enableAddon(conflicting, h.deps);

		expect(result).toEqual({ success: false, error: ADDON_CONFLICT_ERROR });
		expect(getAddonPhase("addon-b")).toBe("disabled");
	});

	test("proceeds when a declared conflict is not enabled", async () => {
		const h = makeHarness();
		const d = makeDescriptor({ id: "addon-b", conflicts: ["addon-a"] });

		const result = await enableAddon(d, h.deps);

		expect(result).toEqual({ success: true, phase: "enabled" });
	});
});
