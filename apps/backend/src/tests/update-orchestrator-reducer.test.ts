/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/
import { describe, expect, test } from "bun:test";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	initialScheduleClock,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";

describe("update-orchestrator reducer — pure state machine", () => {
	test("initial state is idle with fresh clocks and no in-flight progress", () => {
		const state = initialOrchestratorState(1000);
		expect(state.phase).toBe("idle");
		expect(state.enteredAt).toBe(1000);
		expect(state.progress).toBeNull();
		expect(state.failureReason).toBeNull();
		expect(state.packageCheck).toEqual(initialScheduleClock());
		expect(state.osCheck).toEqual(initialScheduleClock());
		expect(state.cellularOverrideId).toBeNull();
	});

	test("full packages happy path: idle -> checking -> available -> awaiting-idle -> downloading -> committing -> restarting-services -> settled -> idle", () => {
		let state = initialOrchestratorState(0);
		state = reduceOrchestrator(state, {
			type: "PACKAGE_CHECK_STARTED",
			now: 1,
		});
		expect(state.phase).toBe("checking");

		state = reduceOrchestrator(state, {
			type: "CHECK_SUCCEEDED_PACKAGES",
			now: 2,
			nextAttemptAt: 999,
		});
		expect(state.phase).toBe("available");
		expect(state.packageCheck.lastSuccessAt).toBe(2);
		expect(state.packageCheck.nextAttemptAt).toBe(999);
		expect(state.packageCheck.consecutiveFailures).toBe(0);

		state = reduceOrchestrator(state, {
			type: "AWAIT_IDLE_FOR_INSTALL",
			now: 3,
		});
		expect(state.phase).toBe("awaiting-idle");

		state = reduceOrchestrator(state, { type: "INSTALL_UNIT_STARTED", now: 4 });
		expect(state.phase).toBe("downloading");
		expect(state.progress).toEqual({ percent: 0, etaSeconds: 0 });

		state = reduceOrchestrator(state, {
			type: "DOWNLOAD_PROGRESS",
			now: 5,
			progress: { percent: 40, etaSeconds: 20 },
		});
		expect(state.phase).toBe("downloading");
		expect(state.progress).toEqual({ percent: 40, etaSeconds: 20 });

		state = reduceOrchestrator(state, { type: "COMMIT_PHASE_ENTERED", now: 6 });
		expect(state.phase).toBe("committing");
		// progress is carried through, not reset, on the sub-phase transition
		expect(state.progress).toEqual({ percent: 40, etaSeconds: 20 });

		state = reduceOrchestrator(state, {
			type: "COMMIT_PROGRESS",
			now: 7,
			progress: { percent: 90, etaSeconds: 2 },
		});
		expect(state.progress).toEqual({ percent: 90, etaSeconds: 2 });

		state = reduceOrchestrator(state, { type: "COMMIT_SUCCEEDED", now: 8 });
		expect(state.phase).toBe("restarting-services");
		expect(state.progress).toBeNull();

		state = reduceOrchestrator(state, { type: "SERVICES_RESTARTED", now: 9 });
		expect(state.phase).toBe("settled");

		state = reduceOrchestrator(state, { type: "SETTLE_ACKNOWLEDGED", now: 10 });
		expect(state.phase).toBe("idle");
	});

	test("a stream-abort during downloading returns to available, not failed", () => {
		let state = initialOrchestratorState(0);
		state = reduceOrchestrator(state, {
			type: "PACKAGE_CHECK_STARTED",
			now: 1,
		});
		state = reduceOrchestrator(state, {
			type: "CHECK_SUCCEEDED_PACKAGES",
			now: 2,
			nextAttemptAt: 999,
		});
		state = reduceOrchestrator(state, {
			type: "AWAIT_IDLE_FOR_INSTALL",
			now: 3,
		});
		state = reduceOrchestrator(state, { type: "INSTALL_UNIT_STARTED", now: 4 });
		expect(state.phase).toBe("downloading");
		state = reduceOrchestrator(state, {
			type: "DOWNLOAD_ABORTED_FOR_STREAM",
			now: 5,
		});
		expect(state.phase).toBe("available");
		expect(state.failureReason).toBeNull();
	});

	test("a download-phase failure (before dpkg ran) goes to failed, never quarantined", () => {
		let state = initialOrchestratorState(0);
		state = reduceOrchestrator(state, {
			type: "PACKAGE_CHECK_STARTED",
			now: 1,
		});
		state = reduceOrchestrator(state, {
			type: "CHECK_SUCCEEDED_PACKAGES",
			now: 2,
			nextAttemptAt: 999,
		});
		state = reduceOrchestrator(state, {
			type: "AWAIT_IDLE_FOR_INSTALL",
			now: 3,
		});
		state = reduceOrchestrator(state, { type: "INSTALL_UNIT_STARTED", now: 4 });
		state = reduceOrchestrator(state, {
			type: "DOWNLOAD_FAILED",
			now: 5,
			reason: "disk full",
		});
		expect(state.phase).toBe("failed");
		expect(state.failureReason).toBe("disk full");
	});

	test("a commit failure is quarantined, never a bare failed", () => {
		let state: OrchestratorState = {
			...initialOrchestratorState(0),
			phase: "committing",
		};
		state = reduceOrchestrator(state, {
			type: "COMMIT_FAILED",
			now: 1,
			reason: "dpkg exited 1",
		});
		expect(state.phase).toBe("quarantined");
		expect(state.failureReason).toBe("dpkg exited 1");
	});

	test("quarantined and failed both leave via an explicit RESET, clearing failureReason", () => {
		for (const phase of ["quarantined", "failed"] as const) {
			const state: OrchestratorState = {
				...initialOrchestratorState(0),
				phase,
				failureReason: "something broke",
			};
			const next = reduceOrchestrator(state, { type: "RESET", now: 5 });
			expect(next.phase).toBe("idle");
			expect(next.failureReason).toBeNull();
		}
	});

	test("historical adjudication clears only the exact unresolved commit with a receipt identity", () => {
		const event = {
			type: "HISTORICAL_COMMIT_ADJUDICATED",
			now: 5,
			decision: "historical_outcome_unresolved_current_slot_unapplied",
			receiptId: "a".repeat(64),
		} as const;
		const failed = {
			...initialOrchestratorState(0),
			phase: "failed" as const,
			failureReason: "commit_unit_absent_on_resume",
		};
		expect(reduceOrchestrator(failed, event).phase).toBe("idle");
		expect(
			reduceOrchestrator({ ...failed, failureReason: "other" }, event).phase,
		).toBe("failed");
		expect(
			reduceOrchestrator({ ...failed, phase: "quarantined" }, event).phase,
		).toBe("quarantined");
	});
});
