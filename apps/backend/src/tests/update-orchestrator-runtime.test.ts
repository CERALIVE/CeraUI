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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
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

const quarantineDirs: string[] = [];

function testQuarantine(): UpdateQuarantine {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-orchestrator-runtime-"));
	quarantineDirs.push(dir);
	return new UpdateQuarantine(join(dir, "quarantine.json"));
}

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
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
		startPackageInstall: () => ({ started: true }),
		getPackageInstallWireState: () => ({ kind: "idle" }) as UpdateState,
		isCommitStageRunning: async () => false,
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
			}),
		);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		const outcome = await checkUpdatesNow();
		expect(outcome).toEqual({ started: true });
		// checkUpdatesNow does not need idle at all — isIdle is never even asked.
		expect(idleChecked).toBe(false);
		expect(getOrchestratorState().phase).toBe("idle");
	});

	test("a successful check with actionable packages reaches the installer", async () => {
		let installs = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				runPackageCheck: async () => null,
				getPackageInstallWireState: () => ({
					kind: "available",
					identity: { version: "app-update", packages: ["cerastream"] },
					package_count: 1,
					actionable_count: 1,
					packages: [{ name: "cerastream", layer: "app", actionable: true }],
				}),
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await checkUpdatesNow();
		expect(getOrchestratorState().phase).toBe("available");
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(installs).toBe(1);
	});

	test("a successful check with only informational packages stays idle and never starts an install", async () => {
		let installs = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				// package_count is the inclusive count (informational rows included); only actionable_count may decide whether an install is launched.
				getPackageInstallWireState: () => ({
					kind: "available",
					identity: { version: "platform-only", packages: ["linux-image"] },
					package_count: 1,
					actionable_count: 0,
					packages: [
						{ name: "linux-image", layer: "platform", actionable: false },
					],
				}),
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest(initialOrchestratorState(0));

		await checkUpdatesNow();
		await runOrchestratorTick();
		await runOrchestratorTick();

		expect(installs).toBe(0);
		expect(getOrchestratorState().phase).toBe("idle");
		expect(getOrchestratorState().failureReason).toBeNull();
		expect(getOrchestratorState().packageCheck.lastSuccessAt).not.toBeNull();
	});
});

describe("installUpdatesNow — bypasses idle, NEVER bypasses the stream-live check", () => {
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

	test("reports stream_active when the stream starts during pending-plan persistence", async () => {
		let releasePending: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			releasePending = resolve;
		});
		let savingPending: (() => void) | undefined;
		const saving = new Promise<void>((resolve) => {
			savingPending = resolve;
		});
		let streamLive = false;
		let launches = 0;
		const quarantine = testQuarantine();
		const savePending = quarantine.savePending.bind(quarantine);
		quarantine.savePending = async (packages) => {
			savingPending?.();
			await pending;
			await savePending(packages);
		};
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine,
				isStreamLive: () => streamLive,
				getPackageInstallWireState: () => ({
					kind: "available",
					identity: { version: "app-update", packages: ["cerastream"] },
					package_count: 1,
					actionable_count: 1,
					packages: [{ name: "cerastream", layer: "app", actionable: true }],
				}),
				startPackageInstall: () => {
					launches++;
					return streamLive
						? { started: false, reason: "streaming" }
						: { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});

		const attempt = installUpdatesNow();
		await saving;
		streamLive = true;
		releasePending?.();

		expect(await attempt).toEqual({ started: false, reason: "stream_active" });
		expect(launches).toBe(1);
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(await quarantine.readPending()).toEqual([]);
	});

	test.each([
		["already_updating", "busy"],
		["check_unavailable", "not_available"],
		["updates_disabled", "busy"],
	] as const)("maps launch refusal %s to %s", async (refusal, reason) => {
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				startPackageInstall: () => ({ started: false, reason: refusal }),
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});

		expect(await installUpdatesNow()).toEqual({ started: false, reason });
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
	});

	test("a refused scheduled launch remains pending for the next tick", async () => {
		let attempts = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				startPackageInstall: () => {
					attempts++;
					return attempts === 1
						? { started: false, reason: "already_updating" }
						: { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});

		await runOrchestratorTick();
		expect(attempts).toBe(1);
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		await runOrchestratorTick();
		expect(attempts).toBe(2);
		expect(getOrchestratorState().phase).toBe("downloading");
	});

	test("starts a pending automatic install immediately when the operator asks during awaiting-idle", async () => {
		let installs = 0;
		let idleChecks = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				isIdle: async () => {
					idleChecks++;
					return false;
				},
				getPackageInstallWireState: () => ({
					kind: "available",
					identity: { version: "app-update", packages: ["cerastream"] },
					package_count: 1,
					actionable_count: 1,
					packages: [{ name: "cerastream", layer: "app", actionable: true }],
				}),
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		await runOrchestratorTick();
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(installs).toBe(0);

		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(installs).toBe(1);
		expect(idleChecks).toBe(1);
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "busy",
		});
		expect(installs).toBe(1);
	});

	test("manual awaiting-idle install persists commit success and releases the launch guard", async () => {
		let installs = 0;
		let wire: UpdateState = {
			kind: "available",
			identity: { version: "app-update", packages: ["cerastream"] },
			package_count: 1,
			actionable_count: 1,
			packages: [{ name: "cerastream", layer: "app", actionable: true }],
		};
		const persisted: string[] = [];
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				isIdle: async () => false,
				getPackageInstallWireState: () => wire,
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
				persist: (next) => persisted.push(next.phase),
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});

		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(installs).toBe(1);
		wire = { kind: "success" } as UpdateState;
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("restarting-services");
		expect(persisted).toEqual([
			"downloading",
			"committing",
			"restarting-services",
		]);

		wire = {
			kind: "available",
			identity: { version: "next-update", packages: ["cerastream"] },
			package_count: 1,
			actionable_count: 1,
			packages: [{ name: "cerastream", layer: "app", actionable: true }],
		};
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(installs).toBe(2);
	});

	test("refuses a live stream from awaiting-idle without launching or changing the pending phase", async () => {
		let installs = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				isStreamLive: () => true,
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "stream_active",
		});
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(installs).toBe(0);
	});

	test("two simultaneous manual requests for the same pending install launch only one unit", async () => {
		let installs = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				quarantine: testQuarantine(),
				getPackageInstallWireState: () => ({
					kind: "available",
					identity: { version: "app-update", packages: ["cerastream"] },
					package_count: 1,
					actionable_count: 1,
					packages: [{ name: "cerastream", layer: "app", actionable: true }],
				}),
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
			}),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "awaiting-idle",
		});
		const first = installUpdatesNow();
		const second = installUpdatesNow();
		expect(await Promise.all([first, second])).toEqual([
			{ started: true },
			{ started: false, reason: "busy" },
		]);
		expect(installs).toBe(1);
	});

	test("refuses manual install while committing or restarting services", async () => {
		let installs = 0;
		setOrchestratorRuntimeDepsForTest(
			fakeDeps({
				startPackageInstall: () => {
					installs++;
					return { started: true };
				},
			}),
		);
		for (const phase of ["committing", "restarting-services"] as const) {
			setOrchestratorStateForTest({ ...initialOrchestratorState(0), phase });
			expect(await installUpdatesNow()).toEqual({
				started: false,
				reason: "busy",
			});
			expect(getOrchestratorState().phase).toBe(phase);
		}
		expect(installs).toBe(0);
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
// critical property this task exists to prove — a refusal, with no stop, once
// the forced-fresh read or the commit-stage probe says the commit stage began.
describe("admitAndPrepareStreamStart — D8 wired to real abort I/O", () => {
	function abortSpyDeps(overrides: Partial<OrchestratorRuntimeDeps> = {}): {
		deps: OrchestratorRuntimeDeps;
		calls: { stop: number; kill: number };
	} {
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

	// The measured Rock 5B+ failure (2026-09-29): dpkg had started, but the
	// wire had not yet ingested its first `Unpacking` line, so the forced-fresh
	// read still said `downloading`. The wire-independent commit-stage probe is
	// what must refuse here. The probe is NOT evidence that dpkg ran, so the
	// refusal must leave the orchestrator's phase alone: no COMMIT_PHASE_ENTERED,
	// nothing persisted, and the next start asks the probe again.
	test("DEDICATED: wire still says downloading but the commit stage is running — refuses, ZERO kill/stop calls, phase NOT latched", async () => {
		let probes = 0;
		let persists = 0;
		const { deps, calls } = abortSpyDeps({
			getPackageInstallWireState: () =>
				({
					kind: "downloading",
					progress: { downloading: 3, unpacking: 0, setting_up: 0, total: 3 },
				}) as UpdateState,
			isCommitStageRunning: async () => {
				probes++;
				return true;
			},
			persist: () => {
				persists++;
			},
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
			progress: { percent: 20, etaSeconds: 90 },
		});

		const result = await admitAndPrepareStreamStart();

		// Probe-only refusals carry a fixed shape: the phase that renders as
		// "an update commit is in progress", and no progress figures (the cached
		// ones are download progress and say nothing about a commit).
		expect(result).toEqual({
			allowed: false,
			reason: "update_in_progress",
			phase: "committing",
			percent: 0,
			etaSeconds: 0,
		});
		expect(probes).toBe(1);
		expect(calls.stop).toBe(0);
		expect(calls.kill).toBe(0);
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(getOrchestratorState().progress).toEqual({
			percent: 20,
			etaSeconds: 90,
		});
		expect(persists).toBe(0);

		const again = await admitAndPrepareStreamStart();
		expect(again).toEqual(result);
		expect(probes).toBe(2);
		expect(calls.stop).toBe(0);
		expect(getOrchestratorState().phase).toBe("downloading");
		expect(persists).toBe(0);
	});

	test("a probe-only refusal keeps download semantics: a later wire `failed` is DOWNLOAD_FAILED, never COMMIT_FAILED/quarantine", async () => {
		const quarantine = testQuarantine();
		let recorded = 0;
		quarantine.recordPackageFailure = async () => {
			recorded++;
		};
		let wire: UpdateState = {
			kind: "downloading",
			progress: { downloading: 3, unpacking: 0, setting_up: 0, total: 3 },
		} as UpdateState;
		const { deps, calls } = abortSpyDeps({
			quarantine,
			getPackageInstallWireState: () => wire,
			isCommitStageRunning: async () => true,
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});

		expect((await admitAndPrepareStreamStart()).allowed).toBe(false);
		expect(calls.stop).toBe(0);

		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("downloading");

		// Stage 2 failed before dpkg ever ran (e.g. a missing archive under
		// --no-download): nothing was installed, so nothing may be quarantined.
		wire = {
			kind: "failed",
			reason: "E: missing archive",
		} as UpdateState;
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("E: missing archive");
		expect(recorded).toBe(0);
	});

	test("probe throws while downloading: refused, phase stays downloading; the next start with a false probe stops the unit and is admitted", async () => {
		let probeAnswer: () => Promise<boolean> = async () => {
			throw new Error("ENOENT: cgroup.procs");
		};
		const { deps, calls } = abortSpyDeps({
			getPackageInstallWireState: () =>
				({
					kind: "downloading",
					progress: { downloading: 1, unpacking: 0, setting_up: 0, total: 3 },
				}) as UpdateState,
			isCommitStageRunning: () => probeAnswer(),
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});

		const refused = await admitAndPrepareStreamStart();
		expect(refused.allowed).toBe(false);
		expect(calls.stop).toBe(0);
		expect(getOrchestratorState().phase).toBe("downloading");

		probeAnswer = async () => false;
		const admitted = await admitAndPrepareStreamStart();
		expect(admitted).toEqual({ allowed: true });
		expect(calls.stop).toBe(1);
		expect(getOrchestratorState().phase).toBe("available");
	});

	test("the commit-stage probe is consulted on the downloading arm and a false answer still aborts the download", async () => {
		let probes = 0;
		const { deps, calls } = abortSpyDeps({
			getPackageInstallWireState: () =>
				({
					kind: "downloading",
					progress: { downloading: 1, unpacking: 0, setting_up: 0, total: 3 },
				}) as UpdateState,
			isCommitStageRunning: async () => {
				probes++;
				return false;
			},
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		const result = await admitAndPrepareStreamStart();
		expect(result).toEqual({ allowed: true });
		expect(probes).toBe(1);
		expect(calls.stop).toBe(1);
		expect(getOrchestratorState().phase).toBe("available");
	});

	test("FAIL CLOSED: the commit-stage probe throws — refuses, ZERO kill/stop calls", async () => {
		const { deps, calls } = abortSpyDeps({
			getPackageInstallWireState: () =>
				({
					kind: "downloading",
					progress: { downloading: 1, unpacking: 0, setting_up: 0, total: 3 },
				}) as UpdateState,
			isCommitStageRunning: async () => {
				throw new Error("cgroup unreadable");
			},
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		const result = await admitAndPrepareStreamStart();
		expect(result).toMatchObject({
			allowed: false,
			reason: "update_in_progress",
			phase: "committing",
		});
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
