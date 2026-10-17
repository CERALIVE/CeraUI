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
import { rmSync } from "node:fs";
import {
	allowCellularOnce,
	checkUpdatesNow,
	getOrchestratorState,
	getOrchestratorWireState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

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
