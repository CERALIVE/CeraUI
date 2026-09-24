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
	ORCHESTRATOR_PHASES,
	type OrchestratorEvent,
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

	test("os path happy sequence through to sync-eligible / syncing / synced", () => {
		let state = initialOrchestratorState(0);
		state = reduceOrchestrator(state, { type: "OS_CHECK_STARTED", now: 1 });
		expect(state.phase).toBe("checking");
		state = reduceOrchestrator(state, {
			type: "CHECK_SUCCEEDED_OS",
			now: 2,
			nextAttemptAt: 999,
		});
		expect(state.phase).toBe("os-available");
		state = reduceOrchestrator(state, { type: "OS_STAGING_STARTED", now: 3 });
		expect(state.phase).toBe("os-staging");
		state = reduceOrchestrator(state, { type: "OS_STAGED", now: 4 });
		expect(state.phase).toBe("os-staged");
		state = reduceOrchestrator(state, { type: "OS_ACTIVATION_ARMED", now: 5 });
		expect(state.phase).toBe("os-activation-armed");
		state = reduceOrchestrator(state, { type: "OS_REBOOT_OBSERVED", now: 6 });
		expect(state.phase).toBe("os-verifying");
		state = reduceOrchestrator(state, { type: "OS_VERIFIED", now: 7 });
		expect(state.phase).toBe("sync-eligible");
		state = reduceOrchestrator(state, { type: "SYNC_STARTED", now: 8 });
		expect(state.phase).toBe("syncing");
		state = reduceOrchestrator(state, { type: "SYNC_SUCCEEDED", now: 9 });
		expect(state.phase).toBe("synced");
		state = reduceOrchestrator(state, { type: "SYNC_SETTLED", now: 10 });
		expect(state.phase).toBe("idle");
	});

	test("an OS rollback detected during verification quarantines, not fails", () => {
		let state: OrchestratorState = {
			...initialOrchestratorState(0),
			phase: "os-verifying",
		};
		state = reduceOrchestrator(state, {
			type: "OS_ROLLBACK_DETECTED",
			now: 1,
			reason: "booted slot != expected",
		});
		expect(state.phase).toBe("quarantined");
		expect(state.failureReason).toBe("booted slot != expected");
	});

	test("a slot-sync failure goes to failed (mirror failure, not a bad version)", () => {
		let state: OrchestratorState = {
			...initialOrchestratorState(0),
			phase: "syncing",
		};
		state = reduceOrchestrator(state, {
			type: "SYNC_FAILED",
			now: 1,
			reason: "slot-sync refused (exit 75)",
		});
		expect(state.phase).toBe("failed");
		expect(state.failureReason).toBe("slot-sync refused (exit 75)");
	});

	test("CHECK_SUCCEEDED_NONE returns to idle for both check kinds and updates only the matching clock", () => {
		for (const kind of ["packages", "os"] as const) {
			let state = initialOrchestratorState(0);
			const startEvent: OrchestratorEvent =
				kind === "packages"
					? { type: "PACKAGE_CHECK_STARTED", now: 1 }
					: { type: "OS_CHECK_STARTED", now: 1 };
			state = reduceOrchestrator(state, startEvent);
			state = reduceOrchestrator(state, {
				type: "CHECK_SUCCEEDED_NONE",
				now: 2,
				kind,
				nextAttemptAt: 500,
			});
			expect(state.phase).toBe("idle");
			const clock = kind === "packages" ? state.packageCheck : state.osCheck;
			const otherClock =
				kind === "packages" ? state.osCheck : state.packageCheck;
			expect(clock.lastSuccessAt).toBe(2);
			expect(clock.nextAttemptAt).toBe(500);
			expect(otherClock).toEqual(initialScheduleClock());
		}
	});

	test("CHECK_FAILED increments consecutiveFailures and records rateLimited on the correct clock only", () => {
		let state = initialOrchestratorState(0);
		state = reduceOrchestrator(state, {
			type: "PACKAGE_CHECK_STARTED",
			now: 1,
		});
		state = reduceOrchestrator(state, {
			type: "CHECK_FAILED",
			now: 2,
			kind: "packages",
			rateLimited: true,
			reason: "429",
			nextAttemptAt: 300,
		});
		expect(state.phase).toBe("idle");
		expect(state.packageCheck.consecutiveFailures).toBe(1);
		expect(state.packageCheck.lastFailureWasRateLimited).toBe(true);
		expect(state.packageCheck.nextAttemptAt).toBe(300);
		expect(state.osCheck).toEqual(initialScheduleClock());
	});

	test("reducer is TOTAL: an unrecognised event for a phase is a referential-equality no-op", () => {
		for (const phase of ORCHESTRATOR_PHASES) {
			const state: OrchestratorState = {
				...initialOrchestratorState(0),
				phase,
			};
			// RESET is only meaningful for quarantined/failed; everywhere else it
			// must be a pure no-op returning the SAME object reference.
			if (phase === "quarantined" || phase === "failed") continue;
			const next = reduceOrchestrator(state, { type: "RESET", now: 1 });
			expect(next).toBe(state);
		}
	});

	test("reducer never throws for any (phase, event-type) combination", () => {
		const now = 1;
		const sampleEvents: OrchestratorEvent[] = [
			{ type: "PACKAGE_CHECK_STARTED", now },
			{ type: "OS_CHECK_STARTED", now },
			{ type: "CHECK_SUCCEEDED_NONE", now, kind: "packages", nextAttemptAt: 1 },
			{ type: "CHECK_SUCCEEDED_PACKAGES", now, nextAttemptAt: 1 },
			{ type: "CHECK_SUCCEEDED_OS", now, nextAttemptAt: 1 },
			{
				type: "CHECK_FAILED",
				now,
				kind: "packages",
				rateLimited: false,
				reason: "x",
				nextAttemptAt: 1,
			},
			{ type: "AWAIT_IDLE_FOR_INSTALL", now },
			{ type: "INSTALL_UNIT_STARTED", now },
			{
				type: "DOWNLOAD_PROGRESS",
				now,
				progress: { percent: 1, etaSeconds: 1 },
			},
			{ type: "DOWNLOAD_FAILED", now, reason: "x" },
			{ type: "DOWNLOAD_ABORTED_FOR_STREAM", now },
			{ type: "COMMIT_PHASE_ENTERED", now },
			{ type: "COMMIT_PROGRESS", now, progress: { percent: 1, etaSeconds: 1 } },
			{ type: "COMMIT_SUCCEEDED", now },
			{ type: "COMMIT_FAILED", now, reason: "x" },
			{ type: "COMMIT_RESUME_UNRESOLVED", now, reason: "x" },
			{ type: "SERVICES_RESTARTED", now },
			{ type: "SETTLE_ACKNOWLEDGED", now },
			{ type: "OS_STAGING_STARTED", now },
			{
				type: "OS_STAGING_PROGRESS",
				now,
				progress: { percent: 1, etaSeconds: 1 },
			},
			{ type: "OS_STAGED", now },
			{ type: "OS_STAGING_FAILED", now, reason: "x" },
			{ type: "OS_STAGING_ABORTED_FOR_STREAM", now },
			{ type: "OS_ACTIVATION_ARMED", now },
			{ type: "OS_REBOOT_OBSERVED", now },
			{ type: "OS_VERIFIED", now },
			{ type: "OS_ROLLBACK_DETECTED", now, reason: "x" },
			{ type: "SYNC_ELIGIBILITY_CONFIRMED", now },
			{ type: "SYNC_STARTED", now },
			{ type: "SYNC_SUCCEEDED", now },
			{ type: "SYNC_FAILED", now, reason: "x" },
			{ type: "SYNC_SETTLED", now },
			{ type: "CELLULAR_OVERRIDE_GRANTED", now, id: "abc" },
			{ type: "RESET", now },
		];
		for (const phase of ORCHESTRATOR_PHASES) {
			for (const event of sampleEvents) {
				const state: OrchestratorState = {
					...initialOrchestratorState(0),
					phase,
				};
				expect(() => reduceOrchestrator(state, event)).not.toThrow();
			}
		}
	});

	test("CELLULAR_OVERRIDE_GRANTED works from idle and does not change the phase", () => {
		const state = initialOrchestratorState(0);
		const next = reduceOrchestrator(state, {
			type: "CELLULAR_OVERRIDE_GRANTED",
			now: 1,
			id: "manifest-v5",
		});
		expect(next.phase).toBe("idle");
		expect(next.cellularOverrideId).toBe("manifest-v5");
	});
});
