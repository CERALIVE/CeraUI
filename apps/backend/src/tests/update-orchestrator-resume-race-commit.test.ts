/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Boot double-recovery ordering race (Todo 43 follow-up, 2026-09-26).
 *
 * main.ts's own standalone `recoverSoftwareUpdateIfRunning()` call (the
 * general startup cleanup, run BEFORE `startUpdateOrchestrator()`) reattaches
 * to an already-finished detached apt unit and consumes the evidence: on a
 * real board, the unit was gone (`systemctl show` reported LoadState=not-found)
 * by the time `resumeOrchestratorState()`'s OWN, separate recovery call ran
 * moments later — so that second call had nothing left to reattach to, even
 * though the underlying transaction had genuinely succeeded.
 *
 * Before the fix, `recoverSoftwareUpdateIfRunning()` returned as soon as it
 * REATTACHED (called `onAttached()`), not once the outcome was RECORDED — the
 * actual drain/cleanup/`lastUpdateSucceeded` assignment ran in a detached,
 * fire-and-forget continuation. So a caller could observe `getUpdateState()`
 * mid-settle, and a second, later caller (the orchestrator) found the unit
 * already gone with the outcome not yet on the wire.
 *
 * This file drives the REAL `recoverSoftwareUpdateIfRunning`/`getUpdateState`
 * from software-updates.ts (not resume.ts's own unit-test fakes) through
 * exactly that two-call sequence, and proves the fix: the moment the
 * boot-level call resolves, the outcome is already settled, so the
 * orchestrator's own resume — finding the unit genuinely gone by then — reads
 * the correct terminal state instead of a transient or absent one.
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
 * Boot double-recovery ordering race (Todo 43 follow-up, 2026-09-26).
 *
 * main.ts's own standalone `recoverSoftwareUpdateIfRunning()` call (the
 * general startup cleanup, run BEFORE `startUpdateOrchestrator()`) reattaches
 * to an already-finished detached apt unit and consumes the evidence: on a
 * real board, the unit was gone (`systemctl show` reported LoadState=not-found)
 * by the time `resumeOrchestratorState()`'s OWN, separate recovery call ran
 * moments later — so that second call had nothing left to reattach to, even
 * though the underlying transaction had genuinely succeeded.
 *
 * Before the fix, `recoverSoftwareUpdateIfRunning()` returned as soon as it
 * REATTACHED (called `onAttached()`), not once the outcome was RECORDED — the
 * actual drain/cleanup/`lastUpdateSucceeded` assignment ran in a detached,
 * fire-and-forget continuation. So a caller could observe `getUpdateState()`
 * mid-settle, and a second, later caller (the orchestrator) found the unit
 * already gone with the outcome not yet on the wire.
 *
 * This file drives the REAL `recoverSoftwareUpdateIfRunning`/`getUpdateState`
 * from software-updates.ts (not resume.ts's own unit-test fakes) through
 * exactly that two-call sequence, and proves the fix: the moment the
 * boot-level call resolves, the outcome is already settled, so the
 * orchestrator's own resume — finding the unit genuinely gone by then — reads
 * the correct terminal state instead of a transient or absent one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSoftwareUpdateProcessMonitor,
	resetSoftwareUpdateRunner,
	setSoftwareUpdateRunner,
} from "../modules/system/software-updates.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

function persistedCommitting(percent: number) {
	return {
		...initialOrchestratorState(1),
		phase: "committing" as const,
		progress: { percent, etaSeconds: 10 },
	};
}

describe("boot double-recovery race — resume must not misread evidence a startup cleanup already consumed", () => {
	let tempRoot: string | undefined;

	afterEach(async () => {
		resetOrchestratorRuntimeForTest();
		resetSoftwareUpdateRunner();
		setOrchestratorStateFilePathForTest(null);
		if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	});

	test("a completed unit persists restarting-services before its deliberate exit, even between ticks", async () => {
		await using h = await updateHarness();
		tempRoot = await mkdtemp(join(tmpdir(), "ceraui-complete-order-"));
		setOrchestratorStateFilePathForTest(join(tempRoot, "agent.json"));
		const pending = new UpdateQuarantine(join(tempRoot, "quarantine.json"));
		await pending.savePending([{ name: "cerastream", version: "2026.9.8" }]);
		const persistedBeforeExit: string[] = [];
		setOrchestratorRuntimeDepsForTest({
			persist: (state) => {
				persistedBeforeExit.push(`${state.phase}:${h.restarts}`);
				saveOrchestratorState(state);
			},
		});
		let onCommitSucceeded: (() => void) | undefined;
		setSoftwareUpdateRunner((hook) => {
			onCommitSucceeded = hook;
			return { started: true };
		});
		expect(defaultOrchestratorRuntimeDeps.startPackageInstall()).toEqual({
			started: true,
		});
		setOrchestratorStateForTest(persistedCommitting(50));
		const monitor = createSoftwareUpdateProcessMonitor();

		await monitor.finish(Promise.resolve(0), onCommitSucceeded);

		expect(persistedBeforeExit).toEqual(["restarting-services:0"]);
		expect(h.restarts).toBe(1);
		expect((await loadOrchestratorState())?.phase).toBe("restarting-services");
		expect(await pending.readPending()).toEqual([
			{ name: "cerastream", version: "2026.9.8" },
		]);
		resetOrchestratorRuntimeForTest();
		await startUpdateOrchestrator({
			...defaultOrchestratorRuntimeDeps,
			recoverSoftwareUpdateIfRunning: async () => false,
			acquireOsStageControl: acquireTestOsStageControl,
			startupRetryClock: { wait: () => Promise.resolve() },
			persist: saveOrchestratorState,
		});
		expect(getOrchestratorState().phase).toBe("restarting-services");
		expect(getOrchestratorState().failureReason).toBeNull();
	});

	test("a proven post-commit restart waits for idle then settles and clears the pending plan with no unit", async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "ceraui-complete-resume-"));
		setOrchestratorStateFilePathForTest(join(tempRoot, "agent.json"));
		const quarantine = new UpdateQuarantine(join(tempRoot, "quarantine.json"));
		await quarantine.savePending([{ name: "cerastream", version: "2026.9.8" }]);
		saveOrchestratorState({
			...persistedCommitting(50),
			phase: "restarting-services",
			progress: null,
		});
		let idle = false;
		let recoveryCalls = 0;
		await startUpdateOrchestrator({
			...defaultOrchestratorRuntimeDeps,
			quarantine,
			acquireOsStageControl: acquireTestOsStageControl,
			startupRetryClock: { wait: () => Promise.resolve() },
			recoverSoftwareUpdateIfRunning: async () => {
				recoveryCalls++;
				return false;
			},
			loadSettings: async () => ({
				packagesAuto: false,
				systemAuto: false,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: false,
				allowSystemOverCellular: false,
			}),
			restartStale: async (isIdle) => isIdle(),
			isIdle: async () => idle,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			persist: saveOrchestratorState,
		});
		expect(recoveryCalls).toBe(0);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("restarting-services");
		expect(await quarantine.readPending()).toHaveLength(1);
		idle = true;
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("settled");
		expect(await quarantine.readPending()).toEqual([]);
		await runOrchestratorTick();
		expect((await loadOrchestratorState())?.phase).toBe("idle");
		expect(recoveryCalls).toBe(0);
	});
});
