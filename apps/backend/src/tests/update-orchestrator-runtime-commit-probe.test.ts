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
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { abortSpyDeps } from "./helpers/orchestrator-runtime-stream-admission.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("admitAndPrepareStreamStart — D8 wired to real abort I/O", () => {
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
});
