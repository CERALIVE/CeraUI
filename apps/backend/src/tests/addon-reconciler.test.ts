/*
 * Post-boot add-on reconciler tests (T29).
 *
 * The reconciler's whole effectful surface is injected via ReconcilerDeps, so
 * these exercise the decision logic — re-materialise vs pending vs defer vs
 * no-op — without a board, a network, or sudo. The two hard guarantees under
 * test: add-ons NEVER gate boot (every failure becomes a persisted `pending`,
 * the run never throws) and a live stream is never disrupted by a refresh.
 */

import { describe, expect, it } from "bun:test";

import type { AddonDescriptor, AddonState } from "@ceraui/rpc/schemas";

import {
	ADDON_NOT_AVAILABLE_FOR_OS_VERSION,
	ADDON_REFRESH_DEFERRED_STREAMING,
	type ReconcilerDeps,
	runAddonReconciler,
} from "../modules/addons/reconciler.ts";

// sha256 of the upstream debug-toolset fixture (matches addons.schema.test.ts).
const FIXTURE_SHA =
	"d0009ed268df5fd0ec12904201c64be392f56671a4d61acec7355188536bb5e9";

function descriptor(over: Partial<AddonDescriptor> = {}): AddonDescriptor {
	return {
		id: "debug-toolset",
		name: "Debug Toolset",
		version: "1.0.0",
		category: "debug",
		payload: { type: "sysext" },
		sysextLevel: "1",
		versionId: "12",
		artifact: {
			urlTemplate:
				"https://apt.ceralive.tv/addons/debug-toolset/{os_version}/debug-toolset.raw",
			sha256: FIXTURE_SHA,
			gpgSigRef:
				"https://apt.ceralive.tv/addons/debug-toolset/{os_version}/debug-toolset.raw.asc",
			sizeDownload: 4194304,
			sizeInstalled: 12582912,
		},
		provides: ["/usr/bin/htop"],
		...over,
	};
}

function enabledState(over: Partial<AddonState> = {}): AddonState {
	return { enabled: true, phase: "active", autoDisabled: false, ...over };
}

type Recorded = { id: string; state: AddonState };

function makeDeps(over: Partial<ReconcilerDeps> = {}): {
	deps: ReconcilerDeps;
	states: Recorded[];
	calls: { fetch: number; refresh: number };
} {
	const states: Recorded[] = [];
	const calls = { fetch: 0, refresh: 0 };
	const deps: ReconcilerDeps = {
		isRealDevice: () => Promise.resolve(true),
		getIsStreaming: () => false,
		getOsVersionId: () => Promise.resolve("12"),
		getBoard: () => "rk3588",
		getAddons: () => ({
			"debug-toolset": enabledState({ osVersionMaterialized: "12" }),
		}),
		readDescriptor: () => Promise.resolve(descriptor()),
		rawExists: () => Promise.resolve(true),
		fetchAndStage: () => {
			calls.fetch++;
			return Promise.resolve();
		},
		refresh: () => {
			calls.refresh++;
			return Promise.resolve();
		},
		setState: (id, state) => {
			states.push({ id, state });
		},
		log: () => {},
		...over,
	};
	return { deps, states, calls };
}

const last = (states: Recorded[]): AddonState | undefined =>
	states[states.length - 1]?.state;

describe("addon reconciler — re-materialisation", () => {
	it("re-materialises an enabled add-on when the staged .raw is missing", async () => {
		const { deps, states, calls } = makeDeps({
			rawExists: () => Promise.resolve(false),
			getAddons: () => ({
				"debug-toolset": enabledState({
					phase: "active",
					osVersionMaterialized: "12",
				}),
			}),
		});

		await runAddonReconciler(deps);

		expect(calls.fetch).toBe(1);
		expect(calls.refresh).toBe(1);
		const s = last(states);
		expect(s?.phase).toBe("active");
		expect(s?.osVersionMaterialized).toBe("12");
		expect(s?.versionMaterialized).toBe("1.0.0");
		expect(s?.lastError).toBeUndefined();
	});

	it("re-materialises when the staged .raw was built for a different VERSION_ID (G1 exact match)", async () => {
		const { deps, states, calls } = makeDeps({
			getOsVersionId: () => Promise.resolve("13"),
			rawExists: () => Promise.resolve(true),
			getAddons: () => ({
				"debug-toolset": enabledState({
					phase: "active",
					osVersionMaterialized: "12",
				}),
			}),
		});

		await runAddonReconciler(deps);

		expect(calls.fetch).toBe(1);
		expect(last(states)?.osVersionMaterialized).toBe("13");
	});

	it("is idempotent: an already-materialised add-on triggers no fetch, refresh, or write", async () => {
		const { deps, states, calls } = makeDeps({
			rawExists: () => Promise.resolve(true),
			getAddons: () => ({
				"debug-toolset": enabledState({
					phase: "active",
					osVersionMaterialized: "12",
				}),
			}),
		});

		await runAddonReconciler(deps);

		expect(calls.fetch).toBe(0);
		expect(calls.refresh).toBe(0);
		expect(states).toHaveLength(0);
	});
});

describe("addon reconciler — pending (no compatible artifact; never blocks)", () => {
	it("sets pending (not error) when the artifact 404s, never refreshing", async () => {
		const { deps, states, calls } = makeDeps({
			rawExists: () => Promise.resolve(false),
			fetchAndStage: () => {
				calls.fetch++;
				return Promise.reject(new Error("fetch failed: HTTP 404"));
			},
		});

		await runAddonReconciler(deps);

		expect(calls.fetch).toBe(1);
		expect(calls.refresh).toBe(0);
		const s = last(states);
		expect(s?.phase).toBe("pending");
		expect(s?.lastError).toBe(ADDON_NOT_AVAILABLE_FOR_OS_VERSION);
		// Desired state is preserved — the add-on stays enabled, retried next boot.
		expect(s?.enabled).toBe(true);
	});

	it("sets pending without fetching when the descriptor lists no compatible OS version", async () => {
		const { deps, states, calls } = makeDeps({
			rawExists: () => Promise.resolve(false),
			readDescriptor: () =>
				Promise.resolve(descriptor({ compatibleOsVersions: ["13"] })),
		});

		await runAddonReconciler(deps);

		expect(calls.fetch).toBe(0);
		expect(calls.refresh).toBe(0);
		expect(last(states)?.phase).toBe("pending");
		expect(last(states)?.lastError).toBe(ADDON_NOT_AVAILABLE_FOR_OS_VERSION);
	});

	it("never throws when an injected dependency itself blows up (boot stays unaffected)", async () => {
		const { deps } = makeDeps({
			getAddons: () => {
				throw new Error("config exploded");
			},
		});

		// Resolves (does not reject) — a throw here would fail the await.
		const result = await runAddonReconciler(deps);
		expect(result).toBeUndefined();
	});
});

describe("addon reconciler — live-stream defer + device gate", () => {
	it("defers (pending) without fetching or refreshing while a stream is live", async () => {
		const { deps, states, calls } = makeDeps({
			getIsStreaming: () => true,
			rawExists: () => Promise.resolve(false),
		});

		await runAddonReconciler(deps);

		expect(calls.fetch).toBe(0);
		expect(calls.refresh).toBe(0);
		const s = last(states);
		expect(s?.phase).toBe("pending");
		expect(s?.lastError).toBe(ADDON_REFRESH_DEFERRED_STREAMING);
	});

	it("does not disrupt a live stream for an already-materialised add-on", async () => {
		const { deps, states, calls } = makeDeps({
			getIsStreaming: () => true,
			rawExists: () => Promise.resolve(true),
			getAddons: () => ({
				"debug-toolset": enabledState({
					phase: "active",
					osVersionMaterialized: "12",
				}),
			}),
		});

		await runAddonReconciler(deps);

		expect(calls.fetch).toBe(0);
		expect(calls.refresh).toBe(0);
		expect(states).toHaveLength(0);
	});

	it("is a no-op in emulated mode (never reads OS version or writes state)", async () => {
		let osRead = false;
		const { deps, states, calls } = makeDeps({
			isRealDevice: () => Promise.resolve(false),
			rawExists: () => Promise.resolve(false),
			getOsVersionId: () => {
				osRead = true;
				return Promise.resolve("12");
			},
		});

		await runAddonReconciler(deps);

		expect(osRead).toBe(false);
		expect(states).toHaveLength(0);
		expect(calls.fetch).toBe(0);
	});

	it("skips disabled and auto-disabled add-ons", async () => {
		const { deps, states, calls } = makeDeps({
			rawExists: () => Promise.resolve(false),
			getAddons: () => ({
				disabled: enabledState({ enabled: false, osVersionMaterialized: "12" }),
				"auto-off": enabledState({
					autoDisabled: true,
					osVersionMaterialized: "12",
				}),
			}),
		});

		await runAddonReconciler(deps);

		expect(calls.fetch).toBe(0);
		expect(states).toHaveLength(0);
	});
});
