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
import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { quarantineDirs } from "./helpers/orchestrator-runtime-harness.ts";
import { abortSpyDeps } from "./helpers/orchestrator-runtime-stream-admission.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("admitAndPrepareStreamStart — D8 wired to real abort I/O", () => {
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
