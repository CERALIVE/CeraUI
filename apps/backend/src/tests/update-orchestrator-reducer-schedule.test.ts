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
	type OrchestratorEvent,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";

describe("update-orchestrator reducer — pure state machine", () => {
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

	test("CELLULAR_OVERRIDE_GRANTED lands in os-available, where the install gate holds", () => {
		const next = reduceOrchestrator(
			{ ...initialOrchestratorState(0), phase: "os-available" },
			{ type: "CELLULAR_OVERRIDE_GRANTED", now: 1, id: "2026.10.0" },
		);
		expect(next.phase).toBe("os-available");
		expect(next.cellularOverrideId).toBe("2026.10.0");
	});
});
