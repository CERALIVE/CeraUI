/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The effects/runtime layer (Todo 36) — the three operator RPC actions and the
 * invariant the plan calls out explicitly: `installUpdatesNow` bypasses IDLE
 * but NEVER bypasses the D8 stream-admission block.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	admitAndPrepareStreamStart,
	allowCellularOnce,
	checkUpdatesNow,
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	getOrchestratorWireState,
	installUpdatesNow,
	type OrchestratorRuntimeDeps,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
});

function fakeDeps(
	overrides: Partial<OrchestratorRuntimeDeps> = {},
): OrchestratorRuntimeDeps {
	return {
		...defaultOrchestratorRuntimeDeps,
		now: () => 1_000_000,
		random: () => 0.5,
		loadSettings: async () => ({
			packagesAuto: true,
			systemAuto: true,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			channel: "stable",
			allowPackagesOverCellular: true,
			allowSystemOverCellular: false,
		}),
		loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		isIdle: async () => true,
		isStreamLive: () => false,
		onlyMeteredCandidateExists: async () => false,
		runPackageCheck: async () => null,
		getAvailablePackageCount: () => 0,
		startPackageInstall: () => ({ started: true }),
		getPackageInstallWireState: () => ({ kind: "idle" }) as UpdateState,
		checkOsManifest: async () => ({
			available: false,
			rateLimited: false,
			failed: false,
			reason: "",
		}),
		startSlotSync: async () => {},
		inspectSlotSync: async () => ({ kind: "absent" }),
		resetSlotSyncFailure: async () => {},
		recoverSoftwareUpdateIfRunning: async () => false,
		persist: () => {},
		...overrides,
	};
}

describe("checkUpdatesNow", () => {
	test("refuses when the phase is already busy (not idle/available/os-available)", async () => {
		setOrchestratorRuntimeDepsForTest(fakeDeps());
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "committing",
		});
		const outcome = await checkUpdatesNow();
		expect(outcome).toEqual({ started: false, reason: "busy" });
	});

	test("bypasses idle: starts even when isIdle() would say false", async () => {
		let idleChecked = false;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				isIdle: async () => {
					idleChecked = true;
					return false;
				},
				runPackageCheck: async () => null,
				getAvailablePackageCount: () => 0,
			}),
		);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		const outcome = await checkUpdatesNow();
		expect(outcome).toEqual({ started: true });
		// checkUpdatesNow does not need idle at all — isIdle is never even asked.
		expect(idleChecked).toBe(false);
		expect(getOrchestratorState().phase).toBe("idle");
	});

	test("a successful check with packages found lands on available", async () => {
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				runPackageCheck: async () => null,
				getAvailablePackageCount: () => 3,
			}),
		);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await checkUpdatesNow();
		expect(getOrchestratorState().phase).toBe("available");
	});
});

describe("installUpdatesNow — bypasses idle, NEVER bypasses stream-admission", () => {
	test("refuses with a typed reason when no update is available (not in the available phase)", async () => {
		setOrchestratorRuntimeDepsForTest(fakeDeps());
		setOrchestratorStateForTest(initialOrchestratorState(0));
		const outcome = await installUpdatesNow();
		expect(outcome).toEqual({ started: false, reason: "not_available" });
	});

	test("refuses busy when already mid-pipeline", async () => {
		setOrchestratorRuntimeDepsForTest(fakeDeps());
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		const outcome = await installUpdatesNow();
		expect(outcome).toEqual({ started: false, reason: "busy" });
	});

	test("MUST NOT DO: refuses stream_active when a stream is live, even though it otherwise bypasses idle — and the phase never leaves 'available'", async () => {
		let installUnitStarted = false;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				isStreamLive: () => true,
				isIdle: async () => true, // idle would say "go", but the stream check must win
				startPackageInstall: () => {
					installUnitStarted = true;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		const outcome = await installUpdatesNow();
		expect(outcome).toEqual({ started: false, reason: "stream_active" });
		// The phase must NOT have moved into awaiting-idle/downloading/committing —
		// an operator action must never queue a Go Live request behind an update,
		// and must never queue an update behind a stream either.
		expect(getOrchestratorState().phase).toBe("available");
		expect(installUnitStarted).toBe(false);
	});

	test("bypasses idle when no stream is live: available -> awaiting-idle -> downloading, without ever consulting isIdle()", async () => {
		let idleChecked = false;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				isStreamLive: () => false,
				isIdle: async () => {
					idleChecked = true;
					return false; // would refuse a scheduled attempt; must not matter here
				},
				startPackageInstall: () => ({ started: true }),
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		const outcome = await installUpdatesNow();
		expect(outcome).toEqual({ started: true });
		expect(idleChecked).toBe(false);
		expect(getOrchestratorState().phase).toBe("downloading");
	});
});

describe("allowCellularOnce", () => {
	test("stamps the exact id onto cellularOverrideId without touching the phase", () => {
		setOrchestratorRuntimeDepsForTest(fakeDeps());
		setOrchestratorStateForTest(initialOrchestratorState(0));
		allowCellularOnce("manifest-v42");
		const state = getOrchestratorState();
		expect(state.cellularOverrideId).toBe("manifest-v42");
		expect(state.phase).toBe("idle");
	});
});

describe("getOrchestratorWireState — additive wire projection", () => {
	test("projects phase/progress/failureReason/cellularOverrideId under the schema-1 envelope", () => {
		setOrchestratorRuntimeDepsForTest(fakeDeps());
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
			progress: { percent: 55, etaSeconds: 12 },
			failureReason: null,
			cellularOverrideId: "x",
		});
		expect(getOrchestratorWireState()).toEqual({
			schema: 1,
			phase: "downloading",
			progress: { percent: 55, etaSeconds: 12 },
			failure_reason: null,
			cellular_override_id: "x",
		});
	});
});

describe("runOrchestratorTick — auto-acknowledges terminal rest phases", () => {
	test("settled -> idle on the next tick", async () => {
		setOrchestratorRuntimeDepsForTest(fakeDeps());
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "settled",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("idle");
	});

	test("synced -> idle on the next tick", async () => {
		setOrchestratorRuntimeDepsForTest(fakeDeps());
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "synced",
		});
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("idle");
	});

	test("a scheduled package check only fires once the clock is due AND the D7 toggle is on", async () => {
		let checkCount = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				loadSettings: async () => ({
					packagesAuto: false,
					systemAuto: false,
					schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
					channel: "stable",
					allowPackagesOverCellular: true,
					allowSystemOverCellular: false,
				}),
				runPackageCheck: async () => {
					checkCount++;
					return null;
				},
			}),
		);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await runOrchestratorTick();
		expect(checkCount).toBe(0); // toggle is off
		expect(getOrchestratorState().phase).toBe("idle");
	});

	test("os checks are gated on the rauc-verity-streaming capability even when due", async () => {
		let osCheckCount = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				loadCapabilities: async () => ({ mode: "legacy", features: [] }),
				checkOsManifest: async () => {
					osCheckCount++;
					return {
						available: false,
						rateLimited: false,
						failed: false,
						reason: "",
					};
				},
			}),
		);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await runOrchestratorTick();
		expect(osCheckCount).toBe(0);
	});
});

// ─── admitAndPrepareStreamStart (Todo 37) ──────────────────────────────────
//
// D8 admission (admission.ts) is exhaustively table-tested elsewhere
// (update-orchestrator-admission.test.ts) against the PURE `admitStreamStart`/
// `onStreamStart`. This suite covers the EFFECTFUL wrapper: the abort-network
// I/O dispatch, the reducer transitions that follow it, and — the safety-
// critical property this task exists to prove — the forced-fresh-read
// refusal that narrows the TOCTOU window documented on the function itself.
describe("admitAndPrepareStreamStart — D8 wired to real abort I/O", () => {
	function abortSpyDeps(
		overrides: Partial<OrchestratorRuntimeDeps> = {},
	): { deps: OrchestratorRuntimeDeps; calls: { stop: number; kill: number } } {
		const calls = { stop: 0, kill: 0 };
		const deps = fakeDeps({
			stopPackageInstallUnit: async () => {
				calls.stop++;
			},
			killAndRestartRaucForStream: async () => {
				calls.kill++;
			},
			...overrides,
		});
		return { deps, calls };
	}

	test("committing refuses via the cached D8 table alone — zero I/O", async () => {
		const { deps, calls } = abortSpyDeps();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "committing",
			progress: { percent: 61, etaSeconds: 40 },
		});
		const result = await admitAndPrepareStreamStart();
		expect(result).toEqual({
			allowed: false,
			reason: "update_in_progress",
			phase: "committing",
			percent: 61,
			etaSeconds: 40,
		});
		expect(calls.stop).toBe(0);
		expect(calls.kill).toBe(0);
	});

	test("restarting-services refuses via the cached D8 table alone — zero I/O", async () => {
		const { deps, calls } = abortSpyDeps();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "restarting-services",
		});
		const result = await admitAndPrepareStreamStart();
		expect(result.allowed).toBe(false);
		expect(calls.stop).toBe(0);
		expect(calls.kill).toBe(0);
	});

	test("idle allows with action 'none' — zero I/O, state untouched", async () => {
		const { deps, calls } = abortSpyDeps();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		const result = await admitAndPrepareStreamStart();
		expect(result).toEqual({ allowed: true });
		expect(calls.stop).toBe(0);
		expect(calls.kill).toBe(0);
		expect(getOrchestratorState().phase).toBe("idle");
	});

	test("syncing allows with action 'continue-local' — zero I/O, phase untouched", async () => {
		const { deps, calls } = abortSpyDeps();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "syncing",
		});
		const result = await admitAndPrepareStreamStart();
		expect(result).toEqual({ allowed: true });
		expect(calls.stop).toBe(0);
		expect(calls.kill).toBe(0);
		expect(getOrchestratorState().phase).toBe("syncing");
	});

	test("genuinely downloading: forced-fresh read confirms still-downloading, aborts the unit", async () => {
		const { deps, calls } = abortSpyDeps({
			getPackageInstallWireState: () =>
				({
					kind: "downloading",
					progress: { downloading: 2, unpacking: 0, setting_up: 0, total: 5 },
				}) as UpdateState,
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
			progress: { percent: 20, etaSeconds: 90 },
		});
		const result = await admitAndPrepareStreamStart();
		expect(result).toEqual({ allowed: true });
		expect(calls.stop).toBe(1);
		expect(calls.kill).toBe(0);
		// DOWNLOAD_ABORTED_FOR_STREAM resets phase to "available" (reducer.ts) —
		// the update goes back to square one rather than being marked failed.
		expect(getOrchestratorState().phase).toBe("available");
	});

	test("DEDICATED: forced-fresh read shows dpkg already committing (cache stale) — refuses, ZERO kill/stop calls", async () => {
		const { deps, calls } = abortSpyDeps({
			// The CACHED state says "downloading" (as if the orchestrator's own
			// tick has not yet observed the transition — up to ACTIVE_TICK_MS
			// stale). The FRESH wire-state read says dpkg has already started.
			getPackageInstallWireState: () =>
				({
					kind: "installing",
					progress: { downloading: 5, unpacking: 2, setting_up: 0, total: 5 },
				}) as UpdateState,
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
			progress: { percent: 20, etaSeconds: 90 },
		});

		const result = await admitAndPrepareStreamStart();

		expect(result).toEqual({
			allowed: false,
			reason: "update_in_progress",
			phase: "committing",
			// COMMIT_PHASE_ENTERED carries the previously-cached progress
			// forward unchanged (see reducer.ts) — this is an admission
			// refusal, not a progress broadcast.
			percent: 20,
			etaSeconds: 90,
		});
		// The safety property this task exists to prove: the forced-fresh
		// read caught the staleness BEFORE any kill/stop was dispatched.
		expect(calls.stop).toBe(0);
		expect(calls.kill).toBe(0);
		// The orchestrator's own cached state is corrected too, so the NEXT
		// admission check (with no further staleness) is already accurate.
		expect(getOrchestratorState().phase).toBe("committing");
	});

	test("forced-fresh read shows the commit already succeeded — refuses, zero kill/stop calls", async () => {
		const { deps, calls } = abortSpyDeps({
			getPackageInstallWireState: () => ({ kind: "success" }) as UpdateState,
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
			progress: { percent: 5, etaSeconds: 200 },
		});
		const result = await admitAndPrepareStreamStart();
		expect(result.allowed).toBe(false);
		expect(calls.stop).toBe(0);
		expect(calls.kill).toBe(0);
	});

	test("genuinely os-staging: kills and restarts RAUC, never touches the apt unit", async () => {
		const { deps, calls } = abortSpyDeps();
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-staging",
			progress: { percent: 30, etaSeconds: 120 },
		});
		const result = await admitAndPrepareStreamStart();
		expect(result).toEqual({ allowed: true });
		expect(calls.kill).toBe(1);
		expect(calls.stop).toBe(0);
		// OS_STAGING_ABORTED_FOR_STREAM resets phase to "os-available".
		expect(getOrchestratorState().phase).toBe("os-available");
	});
});
