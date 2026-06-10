/*
 * T39 — Cog display add-on software QA (emulated dry-run).
 *
 * The on-device render of Cog (WPE WebKit on Mali-G610 EGL/GBM) is
 * HARDWARE-GATED — it cannot be proven without a physical RK3588 (Task 1 spike:
 * NO-GO). The ready-to-run on-hardware checklist lives at
 * image-building-pipeline/v2/docs/cog-display-hw-checklist.md.
 *
 * Everything provable WITHOUT hardware is asserted here, against the real
 * manager/reconciler code with every effectful primitive injected:
 *
 *   1. emulated-mode reconciler dry-run — with cog-display enabled in config the
 *      reconciler skips gracefully (no descriptor read, no fetch, no state write,
 *      never throws) when isRealDevice() is false;
 *   2. G6 enable gate — enableAddon(cog-display) returns
 *      `addon_unavailable_in_emulated_mode` and touches no OS primitive;
 *   3. G6 disable gate — the symmetric guard on disableAddon;
 *   4. wire-path proof — the cog-display descriptor shape the manager consumes
 *      parses cleanly under the CeraUI AddonDescriptorSchema source of truth.
 *
 * Rule D: the descriptor fixture is inlined here (a faithful mirror of
 * image-building-pipeline/v2/manifests/addons/cog-display.json), never read
 * across the repo boundary — a CeraUI test stays self-contained.
 */

import { describe, expect, it } from "bun:test";

import {
	type AddonDescriptor,
	AddonDescriptorSchema,
	type AddonState,
} from "@ceraui/rpc/schemas";

import {
	ADDON_UNAVAILABLE_ERROR,
	type AddonManagerDeps,
	disableAddon,
	enableAddon,
} from "../modules/addons/manager.ts";
import {
	type ReconcilerDeps,
	runAddonReconciler,
} from "../modules/addons/reconciler.ts";

// The manager's config→setup.ts chain throws if setup.json is absent; resilience
// is handled globally by the test preload (bunfig.toml → src/tests/test-preload.ts)
// which stubs setup.ts with required=false, so a static manager import is safe.

// ─── fixtures ────────────────────────────────────────────────────────────────

/**
 * The cog-display descriptor as the CeraUI runtime consumes it — the subset of
 * image-building-pipeline/v2/manifests/addons/cog-display.json that the strict
 * AddonDescriptorSchema currently accepts. The image-baked descriptor ALSO
 * carries `conditions` + `boardVariants` (T37); those extra keys are a documented
 * follow-up for the runtime schema (see the wire-path test below) and are NOT
 * required for the emulated-mode gates this suite proves.
 */
function cogDescriptor(over: Partial<AddonDescriptor> = {}): AddonDescriptor {
	return {
		id: "cog-display",
		name: "Cog Display Engine",
		version: "0.16.1",
		category: "display",
		icon: "monitor",
		payload: { type: "sysext" },
		sysextLevel: "1",
		versionId: "12",
		compatibleOsVersions: ["12"],
		artifact: {
			urlTemplate:
				"https://apt.ceralive.tv/addons/cog-display/{os_version}/cog-display-{board}-{os_version}.raw",
			sha256:
				"0000000000000000000000000000000000000000000000000000000000000000",
			gpgSigRef:
				"https://apt.ceralive.tv/addons/cog-display/{os_version}/cog-display-{board}-{os_version}.raw.sig",
			sizeDownload: 57671680,
			sizeInstalled: 125829120,
		},
		provides: [
			"/usr/bin/cog",
			"/usr/bin/cage",
			"/usr/lib/systemd/system/cog.service",
			"/usr/lib/systemd/system/cage.service",
		],
		deps: [],
		conflicts: [],
		units: {
			unmask: ["cage.service", "cog.service"],
			enable: ["cage.service", "cog.service"],
			start: ["cage.service", "cog.service"],
		},
		validate: { cmd: "/usr/bin/cog --version", timeout: 10 },
		...over,
	};
}

/** cog-display, enabled in config — the desired state the reconciler reconciles. */
function cogEnabledState(over: Partial<AddonState> = {}): AddonState {
	return {
		enabled: true,
		phase: "active",
		autoDisabled: false,
		osVersionMaterialized: "12",
		...over,
	};
}

// ─── 1. reconciler dry-run — emulated mode skips gracefully ──────────────────

describe("T39 cog-display — reconciler emulated-mode dry-run", () => {
	function makeReconcilerDeps(over: Partial<ReconcilerDeps> = {}): {
		deps: ReconcilerDeps;
		probes: {
			osRead: boolean;
			descriptorRead: boolean;
			fetch: number;
			refresh: number;
			writes: number;
		};
	} {
		const probes = {
			osRead: false,
			descriptorRead: false,
			fetch: 0,
			refresh: 0,
			writes: 0,
		};
		const deps: ReconcilerDeps = {
			// G6 — emulated: the whole run is a no-op.
			isRealDevice: () => Promise.resolve(false),
			getIsStreaming: () => false,
			getOsVersionId: () => {
				probes.osRead = true;
				return Promise.resolve("12");
			},
			getBoard: () => "rock-5b-plus",
			getAddons: () => ({ "cog-display": cogEnabledState() }),
			readDescriptor: () => {
				probes.descriptorRead = true;
				return Promise.resolve(cogDescriptor());
			},
			rawExists: () => Promise.resolve(false),
			fetchAndStage: () => {
				probes.fetch++;
				return Promise.resolve();
			},
			refresh: () => {
				probes.refresh++;
				return Promise.resolve();
			},
			setState: () => {
				probes.writes++;
			},
			log: () => {},
			...over,
		};
		return { deps, probes };
	}

	it("skips without reading the OS version, fetching, refreshing, or writing state", async () => {
		const { deps, probes } = makeReconcilerDeps();

		const result = await runAddonReconciler(deps);

		// Returns (never throws) and short-circuits before any effectful step.
		expect(result).toBeUndefined();
		expect(probes.osRead).toBe(false);
		expect(probes.descriptorRead).toBe(false);
		expect(probes.fetch).toBe(0);
		expect(probes.refresh).toBe(0);
		expect(probes.writes).toBe(0);
	});

	it("would materialise cog-display on a real device (positive control)", async () => {
		// Same desired state, but isRealDevice() true and the staged .raw missing:
		// the reconciler now fetches + refreshes — proving the emulated skip above
		// is the device gate, not a dead code path.
		const { deps, probes } = makeReconcilerDeps({
			isRealDevice: () => Promise.resolve(true),
			rawExists: () => Promise.resolve(false),
		});

		await runAddonReconciler(deps);

		expect(probes.osRead).toBe(true);
		expect(probes.fetch).toBe(1);
		expect(probes.refresh).toBe(1);
		expect(probes.writes).toBeGreaterThan(0);
	});
});

// ─── 2 + 3. manager enable/disable — G6 emulated-mode gate ───────────────────

describe("T39 cog-display — manager G6 emulated-mode gate", () => {
	function gatedDeps(): {
		deps: AddonManagerDeps;
		touched: { os: boolean; net: boolean; systemctl: boolean };
	} {
		const touched = { os: false, net: false, systemctl: false };
		const unreached = (label: keyof typeof touched) => {
			touched[label] = true;
		};
		const deps: AddonManagerDeps = {
			// G6 — emulated mode. Every other primitive flips a "touched" flag so
			// the test proves the gate returns BEFORE any OS/network side effect.
			isRealDevice: () => Promise.resolve(false),
			getDataFreeBytes: () => {
				unreached("os");
				return Promise.resolve(Number.MAX_SAFE_INTEGER);
			},
			getOsVersion: () => {
				unreached("os");
				return Promise.resolve("12");
			},
			download: () => {
				unreached("net");
				return Promise.resolve();
			},
			verify: () => Promise.resolve(),
			stage: () => Promise.resolve(),
			helperEnable: () => Promise.resolve(),
			helperDisable: () => Promise.resolve(),
			systemctl: () => {
				unreached("systemctl");
				return Promise.resolve({ stdout: "", stderr: "" });
			},
			getNRestarts: () => Promise.resolve(0),
			runValidate: () => Promise.resolve(true),
			removeArtifact: () => Promise.resolve(),
			getState: () => undefined,
			setState: () => {},
			removeState: () => {},
			broadcast: () => {},
		};
		return { deps, touched };
	}

	it("enableAddon(cog-display) returns addon_unavailable_in_emulated_mode (G6)", async () => {
		const { deps, touched } = gatedDeps();

		const result = await enableAddon(cogDescriptor(), deps);

		expect(result).toEqual({
			success: false,
			error: ADDON_UNAVAILABLE_ERROR,
		});
		expect(ADDON_UNAVAILABLE_ERROR).toBe("addon_unavailable_in_emulated_mode");
		// No OS/network/systemctl primitive was reached.
		expect(touched).toEqual({ os: false, net: false, systemctl: false });
	});

	it("disableAddon(cog-display) is gated the same way (symmetry)", async () => {
		const { deps, touched } = gatedDeps();

		const result = await disableAddon(cogDescriptor(), deps);

		expect(result).toEqual({
			success: false,
			error: ADDON_UNAVAILABLE_ERROR,
		});
		expect(touched.systemctl).toBe(false);
	});
});

// ─── 4. wire-path proof — descriptor validates against the CeraUI schema ─────

describe("T39 cog-display — descriptor wire-path", () => {
	it("the runtime descriptor shape parses under AddonDescriptorSchema", () => {
		const parsed = AddonDescriptorSchema.safeParse(cogDescriptor());
		expect(parsed.success).toBe(true);
	});

	it("documents the strict-schema gap: conditions/boardVariants are not yet mirrored (T37 follow-up)", () => {
		// The image-baked cog-display.json ALSO carries `conditions` and
		// `boardVariants`. The CeraUI AddonDescriptorSchema is .strict() and does
		// not yet model them, so a descriptor carrying those extra keys is
		// REJECTED today. This is the documented T37 follow-up (mirror the
		// optional fields + extend ADDON_PHASES). Locking it with a test makes the
		// gap visible and turns the eventual schema extension into a deliberate,
		// test-driven change rather than a silent drift.
		const withExtraKeys = {
			...cogDescriptor(),
			conditions: {
				requires_display: true,
				requires_gpu_userspace: true,
				min_os_version: "12",
				boardAllowlist: ["rock-5b-plus", "orange-pi-5-plus"],
			},
			boardVariants: {
				"rock-5b-plus": cogDescriptor().artifact,
				"orange-pi-5-plus": cogDescriptor().artifact,
			},
		};
		const parsed = AddonDescriptorSchema.safeParse(withExtraKeys);
		expect(parsed.success).toBe(false);
	});
});
