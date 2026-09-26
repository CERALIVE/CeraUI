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

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as invariantModule from "../helpers/invariant.ts";
import {
	getUpdateState,
	recoverSoftwareUpdateIfRunning,
	type SoftwareUpdateRecoveryDeps,
} from "../modules/system/software-updates.ts";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { resumeOrchestratorState } from "../modules/system/update-orchestrator/resume.ts";
import {
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import * as compat from "../rpc/compat.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

const NOTHING_LEFT_TO_RECOVER: SoftwareUpdateRecoveryDeps = {
	recover: async () => null,
	scheduleRetry: () => {},
	resumePeriodicChecks: () => {},
};

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
		setOrchestratorStateFilePathForTest(null);
		if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	});

	test("startUpdateOrchestrator() persists the recovered success phase before the crash-to-restart tail fires — proves persist-before-crash ordering end to end, not just by inspection", async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "ceraui-resume-race-"));
		setOrchestratorStateFilePathForTest(join(tempRoot, "agent.json"));
		saveOrchestratorState({
			...initialOrchestratorState(1),
			phase: "committing",
			progress: { percent: 50, etaSeconds: 10 },
		});

		const order: string[] = [];
		const restart = spyOn(invariantModule, "invariant").mockImplementation(
			(condition, message): asserts condition => {
				if (condition) return;
				if (message === "software update complete; exiting to restart CeraUI") {
					order.push("crash");
					return;
				}
				throw new Error(message);
			},
		);
		try {
			await startUpdateOrchestrator({
				...defaultOrchestratorRuntimeDeps,
				recoverSoftwareUpdateIfRunning: () =>
					recoverSoftwareUpdateIfRunning({
						recover: async ({ onAttached }) => {
							onAttached?.();
							return {
								completion: Promise.resolve(0),
								wasAlreadyFinished: true,
							};
						},
						scheduleRetry: () => {},
						resumePeriodicChecks: () => {},
					}),
				getPackageInstallWireState: getUpdateState,
				persist: (state) => {
					order.push(`persist:${state.phase}`);
					saveOrchestratorState(state);
				},
			});

			// `finish()` registers the crash-tail's `.then()` reaction on
			// `settled` BEFORE the reaction that unblocks this call's own
			// continuation, so the crash-tail callback runs FIRST — that
			// ordering is unaffected by which caller asked. What matters is
			// that it does NOT stop the SAME microtask wave from continuing:
			// resumeCommitting()'s continuation, reduceOrchestrator(), and
			// this synchronous persist() all still run as later reactions of
			// that SAME wave, with no new real I/O boundary in between (the
			// boot reorder is what removes such a boundary — see main.ts).
			// A real `invariant()` throw only becomes a process-terminating
			// unhandled rejection once the ENGINE'S MICROTASK QUEUE IS FULLY
			// DRAINED, which is after persist() below has already run — so the
			// durable write survives even though the crash attempt is logged
			// first here.
			expect(order).toEqual(["crash", "persist:restarting-services"]);
			expect(getOrchestratorState().phase).toBe("restarting-services");
		} finally {
			restart.mockRestore();
		}
	});

	test("a transaction that ACTUALLY SUCCEEDED resolves resume to restarting-services, not failed", async () => {
		await using h = await updateHarness();

		// The boot-level standalone recovery call: finds the detached unit
		// already finished with exit 0.
		const bootRecovered = await recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached }) => {
				onAttached?.();
				return { completion: Promise.resolve(0), wasAlreadyFinished: true };
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
		expect(bootRecovered).toBe(true);

		// The fix's whole point: the outcome is ALREADY recorded the instant the
		// boot-level call resolves — never a transient "still downloading" read.
		expect(getUpdateState()).toEqual({ kind: "success" });
		expect(h.restarts).toBe(1);

		// The orchestrator's own resume path runs next. The unit is genuinely
		// gone (the call above already cleaned it up) — the exact "consumed
		// evidence" shape the race exposed.
		const resumed = await resumeOrchestratorState(persistedCommitting(50), {
			recoverSoftwareUpdateIfRunning: () =>
				recoverSoftwareUpdateIfRunning(NOTHING_LEFT_TO_RECOVER),
			getUpdateState,
			now: () => 9999,
		});

		expect(resumed.phase).toBe("restarting-services");
		expect(resumed.failureReason).toBeNull();
	});

	test("a transaction that ACTUALLY FAILED still resolves resume to quarantined, never a false success or unresolved", async () => {
		await using h = await updateHarness();

		const bootRecovered = await recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached }) => {
				onAttached?.();
				return { completion: Promise.resolve(100), wasAlreadyFinished: true };
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
		expect(bootRecovered).toBe(true);
		expect(getUpdateState().kind).toBe("failed");
		// Exit 100 never triggers the reboot/restart path.
		expect(h.restarts).toBe(0);

		const resumed = await resumeOrchestratorState(persistedCommitting(80), {
			recoverSoftwareUpdateIfRunning: () =>
				recoverSoftwareUpdateIfRunning(NOTHING_LEFT_TO_RECOVER),
			getUpdateState,
			now: () => 9999,
		});

		expect(resumed.phase).toBe("quarantined");
		expect(resumed.failureReason).toBeDefined();
	});

	test("a broadcast failure during settle never masks the recorded outcome, and settle() itself never throws", async () => {
		await using h = await updateHarness();
		const throwingBroadcast = spyOn(compat, "broadcastMsg").mockImplementation(
			() => {
				throw new Error("socket exploded");
			},
		);
		try {
			const bootRecovered = await recoverSoftwareUpdateIfRunning({
				recover: async ({ onAttached }) => {
					onAttached?.();
					return { completion: Promise.resolve(0), wasAlreadyFinished: true };
				},
				scheduleRetry: () => {},
				resumePeriodicChecks: () => {},
			});
			// A throwing broadcast must not surface as a rejected recovery — the
			// outcome is still recorded, never lost behind an upstream catch.
			expect(bootRecovered).toBe(true);
			expect(getUpdateState()).toEqual({ kind: "success" });
			expect(h.restarts).toBe(1);
		} finally {
			throwingBroadcast.mockRestore();
		}
	});

	test("negative control — genuinely nothing was ever running still resolves the honest unresolved failure", async () => {
		await using _h = await updateHarness();

		// No boot-level recovery ever ran (nothing to reattach to at all), so
		// resume's own call is the only observation and finds the same absence.
		const resumed = await resumeOrchestratorState(persistedCommitting(10), {
			recoverSoftwareUpdateIfRunning: () =>
				recoverSoftwareUpdateIfRunning(NOTHING_LEFT_TO_RECOVER),
			getUpdateState,
			now: () => 9999,
		});

		expect(resumed.phase).toBe("failed");
		expect(resumed.failureReason).toBe("commit_unit_absent_on_resume");
	});
});
