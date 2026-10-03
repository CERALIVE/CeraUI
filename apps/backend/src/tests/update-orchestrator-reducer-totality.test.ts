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
	ORCHESTRATOR_PHASES,
	type OrchestratorEvent,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import {
	assertUnlaunchedTotalityOutcome,
	unlaunchedTotalitySample,
} from "./helpers/unlaunched-totality-sample.ts";

describe("update-orchestrator reducer — pure state machine", () => {
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
			unlaunchedTotalitySample(now),
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
			{ type: "OS_STAGE_SETTLED", now, attemptId: "a" },
			{ type: "OS_STAGE_OFFER_INVALIDATED", now, attemptId: "a" },
			{ type: "OS_STAGING_FAILED", now, reason: "x" },
			{ type: "OS_STAGING_ABORTED_FOR_STREAM", now },
			{ type: "OS_ACTIVATION_ARMED", now },
			{ type: "OS_REBOOT_OBSERVED", now },
			{ type: "OS_VERIFIED", now },
			{ type: "OS_ROLLBACK_DETECTED", now, reason: "x" },
			{ type: "SYNC_ELIGIBILITY_CONFIRMED", now },
			{ type: "SYNC_SKIPPED", now },
			{ type: "SYNC_STARTED", now },
			{ type: "SYNC_SUCCEEDED", now },
			{ type: "SYNC_FAILED", now, reason: "x" },
			{ type: "SYNC_SETTLED", now },
			{ type: "CELLULAR_OVERRIDE_GRANTED", now, id: "abc" },
			{
				type: "OS_STAGING_STARTED",
				now,
				attempt: { candidateKey: "k", attemptId: "a" },
			},
			{
				type: "OS_STAGING_FAILED",
				now,
				reason: "x",
				recovery: { attemptId: "a", mode: "automatic" },
			},
			{ type: "OS_STAGE_RECOVERY_CONFIRMED", now, candidateKey: "k" },
			{ type: "OS_STAGE_LEGACY_FAILURE_MIGRATED", now, retryAt: 2 },
			{ type: "RESET", now },
		];
		for (const phase of ORCHESTRATOR_PHASES) {
			for (const event of sampleEvents) {
				const state: OrchestratorState = {
					...initialOrchestratorState(0),
					phase,
				};
				expect(() => reduceOrchestrator(state, event)).not.toThrow();
				if (event.type === "OS_UNLAUNCHED_STAGE_SETTLED")
					assertUnlaunchedTotalityOutcome(phase, event);
				if (
					event.type === "OS_STAGE_SETTLED" ||
					event.type === "OS_STAGE_OFFER_INVALIDATED" ||
					event.type === "OS_STAGE_RECOVERY_CONFIRMED"
				)
					expect(reduceOrchestrator(state, event)).toBe(state);
				if (event.type === "OS_STAGED")
					expect(reduceOrchestrator(state, event).phase).toBe(
						phase === "os-staging" ? "os-staged" : phase,
					);
			}
		}
	});
});
