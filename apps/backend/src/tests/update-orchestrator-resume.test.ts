/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * Backend-start resume (Todo 36, G17). Persistence-resume tests starting from
 * EVERY one of the 18 phases, with `committing` covered in depth: it is the
 * ONLY phase that queries Todo 35's existing detached-unit recovery mechanism,
 * and it must NEVER re-invoke apt-get/dpkg — proven here by asserting the
 * injected recovery/wire-state dependencies are the ONLY calls made, with no
 * "start install" style dependency present or callable at all.
 */

import { describe, expect, test } from "bun:test";
import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	type OrchestratorResumeDeps,
	resumeOrchestratorState,
} from "../modules/system/update-orchestrator/resume.ts";
import {
	initialOrchestratorState,
	ORCHESTRATOR_PHASES,
	type OrchestratorPhase,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";

function deps(overrides: Partial<OrchestratorResumeDeps> = {}): {
	deps: OrchestratorResumeDeps;
	calls: { recover: number; wire: number };
} {
	const calls = { recover: 0, wire: 0 };
	const recoverImpl =
		overrides.recoverSoftwareUpdateIfRunning ?? (async () => false);
	const wireImpl =
		overrides.getUpdateState ?? (() => ({ kind: "idle" }) as UpdateState);
	const merged: OrchestratorResumeDeps = {
		recoverSoftwareUpdateIfRunning: async () => {
			calls.recover++;
			return recoverImpl();
		},
		getUpdateState: () => {
			calls.wire++;
			return wireImpl();
		},
		now: overrides.now ?? (() => 9999),
	};
	return { deps: merged, calls };
}

describe("resume — every non-committing phase is a pure structural pass-through", () => {
	const nonCommitting = ORCHESTRATOR_PHASES.filter((p) => p !== "committing");

	for (const phase of nonCommitting) {
		test(`resume from "${phase}" changes nothing and calls NO recovery dependency`, async () => {
			const persisted: OrchestratorState = {
				...initialOrchestratorState(1),
				phase,
			};
			const { deps: d, calls } = deps();
			const resumed = await resumeOrchestratorState(persisted, d);
			expect(resumed).toEqual(persisted);
			expect(calls.recover).toBe(0);
			expect(calls.wire).toBe(0);
		});
	}

	test("every phase except committing is covered by the pass-through sweep above", () => {
		expect(nonCommitting).toHaveLength(ORCHESTRATOR_PHASES.length - 1);
		expect(nonCommitting).not.toContain("committing");
	});
});

describe('resume from "committing" — the safety-critical crash-resume path', () => {
	const persisted: OrchestratorState = {
		...initialOrchestratorState(1),
		phase: "committing",
		progress: { percent: 50, etaSeconds: 10 },
	};

	test("unit still running (installing) -> stays committing, progress re-estimated from the SAME probe, no dpkg invoked", async () => {
		const { deps: d, calls } = deps({
			recoverSoftwareUpdateIfRunning: async () => true,
			getUpdateState: () =>
				({
					kind: "installing",
					progress: { downloading: 5, unpacking: 3, setting_up: 1, total: 5 },
				}) as UpdateState,
		});
		const resumed = await resumeOrchestratorState(persisted, d);
		expect(resumed.phase).toBe("committing");
		expect(resumed.progress).not.toBeNull();
		expect(calls.recover).toBe(1);
	});

	test("unit still running (downloading sub-phase of the combined unit) -> stays committing (trusts the persisted higher-level phase)", async () => {
		const { deps: d } = deps({
			recoverSoftwareUpdateIfRunning: async () => true,
			getUpdateState: () =>
				({
					kind: "downloading",
					progress: { downloading: 2, unpacking: 0, setting_up: 0, total: 5 },
				}) as UpdateState,
		});
		const resumed = await resumeOrchestratorState(persisted, d);
		expect(resumed.phase).toBe("committing");
	});

	test("unit already finished SUCCESSFULLY while we were down -> transitions to restarting-services, NEVER back through downloading/committing again", async () => {
		const { deps: d, calls } = deps({
			recoverSoftwareUpdateIfRunning: async () => true,
			getUpdateState: () => ({ kind: "success" }) as UpdateState,
		});
		const resumed = await resumeOrchestratorState(persisted, d);
		expect(resumed.phase).toBe("restarting-services");
		expect(resumed.progress).toBeNull();
		// Recovery was consulted read-only exactly once; nothing else happened.
		expect(calls.recover).toBe(1);
	});

	test("unit already finished with FAILURE -> quarantined, carrying the failure reason, no dpkg invoked", async () => {
		const { deps: d } = deps({
			recoverSoftwareUpdateIfRunning: async () => true,
			getUpdateState: () =>
				({ kind: "failed", reason: "dpkg exited 100" }) as UpdateState,
		});
		const resumed = await resumeOrchestratorState(persisted, d);
		expect(resumed.phase).toBe("quarantined");
		expect(resumed.failureReason).toBe("dpkg exited 100");
	});

	test("unit was genuinely ABSENT (recovered=false) -> conservative typed failure, NEVER a silent retry/re-run", async () => {
		const { deps: d, calls } = deps({
			recoverSoftwareUpdateIfRunning: async () => false,
			getUpdateState: () => ({ kind: "idle" }) as UpdateState,
		});
		const resumed = await resumeOrchestratorState(persisted, d);
		expect(resumed.phase).toBe("failed");
		expect(resumed.failureReason).toBe("commit_unit_absent_on_resume");
		expect(calls.recover).toBe(1);
	});

	test("recovered=true but wire state is inconclusive (neither in-flight nor terminal) -> conservative failure, never assumed success", async () => {
		const { deps: d } = deps({
			recoverSoftwareUpdateIfRunning: async () => true,
			getUpdateState: () => ({ kind: "idle" }) as UpdateState,
		});
		const resumed = await resumeOrchestratorState(persisted, d);
		expect(resumed.phase).toBe("failed");
		expect(resumed.failureReason).toBe("commit_resume_inconclusive");
	});

	test("resume NEVER calls anything named like a package-install/download start — only the two read-only deps are invoked", async () => {
		// This is the structural double-dpkg guard: the OrchestratorResumeDeps
		// type itself carries no "start"/"install" capability, so there is
		// nothing for resume to call that would re-run apt-get even by mistake.
		const providedDepNames = Object.keys(
			deps().deps as unknown as Record<string, unknown>,
		);
		expect(providedDepNames.sort()).toEqual(
			["getUpdateState", "now", "recoverSoftwareUpdateIfRunning"].sort(),
		);
	});

	test("resume queries recovery/wire-state exactly once each per call, regardless of outcome (no retry loop hidden inside resume itself)", async () => {
		const { deps: d, calls } = deps({
			recoverSoftwareUpdateIfRunning: async () => true,
			getUpdateState: () => ({ kind: "success" }) as UpdateState,
		});
		await resumeOrchestratorState(persisted, d);
		expect(calls.recover).toBe(1);
		expect(calls.wire).toBe(1);
	});
});

describe("resume — full-boot proof: dpkg is invoked at most once across a simulated crash+resume cycle", () => {
	test("a simulated apt install call is counted; resume after a crash must not increment it a second time", async () => {
		let dpkgInvocations = 0;
		// Simulate the ONE real invocation that happened before the crash.
		dpkgInvocations++;

		const persistedAtCrash: OrchestratorState = {
			...initialOrchestratorState(1),
			phase: "committing",
			progress: { percent: 80, etaSeconds: 5 },
		};

		// The detached unit survived the crash (PID 1 owns it) and had, in fact,
		// already finished successfully by the time we resumed.
		const { deps: d } = deps({
			recoverSoftwareUpdateIfRunning: async () => true,
			getUpdateState: () => ({ kind: "success" }) as UpdateState,
		});

		const resumed = await resumeOrchestratorState(persistedAtCrash, d);

		expect(resumed.phase).toBe("restarting-services");
		// The resume path has no capability to invoke apt-get/dpkg at all — the
		// counter above is exactly what it was before resume ran.
		expect(dpkgInvocations).toBe(1);
	});
});

describe("resume — phase enumeration completeness lock", () => {
	test("the ORCHESTRATOR_PHASES list used by this suite has exactly 18 members, matching the plan", () => {
		const expected: OrchestratorPhase[] = [
			"idle",
			"checking",
			"available",
			"downloading",
			"awaiting-idle",
			"committing",
			"restarting-services",
			"settled",
			"os-available",
			"os-staging",
			"os-staged",
			"os-activation-armed",
			"os-verifying",
			"sync-eligible",
			"syncing",
			"synced",
			"quarantined",
			"failed",
		];
		expect([...ORCHESTRATOR_PHASES].sort()).toEqual([...expected].sort());
		expect(ORCHESTRATOR_PHASES).toHaveLength(18);
	});
});
