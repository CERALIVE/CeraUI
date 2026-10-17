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
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import {
	fail,
	KEY,
	MIN,
	staging,
} from "./helpers/orchestrator-reducer-recovery.ts";

describe("update-orchestrator reducer — OS stage recovery", () => {
	test("a successful check of the same candidate keeps the budget; a different one drops it", () => {
		const waiting = fail(staging("a1"), "a1", "automatic");
		const checking = reduceOrchestrator(waiting, {
			type: "OS_CHECK_STARTED",
			now: 2_000,
		});
		const same = reduceOrchestrator(checking, {
			type: "CHECK_SUCCEEDED_OS",
			now: 2_001,
			nextAttemptAt: 99_999,
			candidateKey: KEY,
		});
		expect(same.osStageRecovery).toEqual(waiting.osStageRecovery);
		const other = reduceOrchestrator(checking, {
			type: "CHECK_SUCCEEDED_OS",
			now: 2_001,
			nextAttemptAt: 99_999,
			candidateKey: "other",
		});
		expect(other.osStageRecovery).toBeUndefined();
		const none = reduceOrchestrator(checking, {
			type: "CHECK_SUCCEEDED_NONE",
			now: 2_001,
			kind: "os",
			nextAttemptAt: 99_999,
		});
		expect(none.phase).toBe("idle");
		expect(none.osStageRecovery).toBeUndefined();
	});

	test("a package check leaves a waiting OS candidate and the record rides through the package phases", () => {
		const waiting = fail(staging("a1"), "a1", "automatic");
		let state = reduceOrchestrator(waiting, {
			type: "PACKAGE_CHECK_STARTED",
			now: 2_000,
		});
		expect(state.phase).toBe("checking");
		for (const event of [
			{ type: "CHECK_SUCCEEDED_PACKAGES", now: 2_001, nextAttemptAt: 9 },
			{ type: "AWAIT_IDLE_FOR_INSTALL", now: 2_002 },
			{ type: "INSTALL_UNIT_STARTED", now: 2_003 },
			{ type: "COMMIT_PHASE_ENTERED", now: 2_004 },
			{ type: "COMMIT_SUCCEEDED", now: 2_005 },
			{ type: "SERVICES_RESTARTED", now: 2_006 },
			{ type: "SETTLE_ACKNOWLEDGED", now: 2_007 },
		] as const) {
			state = reduceOrchestrator(state, event);
		}
		expect(state.phase).toBe("idle");
		expect(state.osStageRecovery).toEqual(waiting.osStageRecovery);
	});

	test("recovery confirmation clears only a matching unsafe OS record and hands the next round to the operator", () => {
		const unsafe = reduceOrchestrator(staging("a1"), {
			type: "OS_STAGING_FAILED",
			now: 1_000,
			reason: "rauc_recovery_unproven",
			recovery: { attemptId: "a1", mode: "unsafe" },
		});
		const confirmed = reduceOrchestrator(unsafe, {
			type: "OS_STAGE_RECOVERY_CONFIRMED",
			now: 4_000,
			candidateKey: KEY,
		});
		expect(confirmed.phase).toBe("idle");
		expect(confirmed.failureReason).toBeNull();
		expect(confirmed.osCheck.nextAttemptAt).toBe(4_000);
		expect(confirmed.osStageRecovery).toMatchObject({
			mode: "operator",
			failedRounds: 1,
		});
		expect(
			reduceOrchestrator(unsafe, {
				type: "OS_STAGE_RECOVERY_CONFIRMED",
				now: 4_000,
				candidateKey: "other",
			}),
		).toBe(unsafe);
	});

	test("recovery confirmation rejects package, X6 and quarantined failures", () => {
		const event = {
			type: "OS_STAGE_RECOVERY_CONFIRMED",
			now: 1,
			candidateKey: KEY,
		} as const;
		const waiting = fail(staging("a1"), "a1", "automatic");
		const packageFailure: OrchestratorState = {
			...initialOrchestratorState(0),
			phase: "failed",
			failureReason: "apt-exit-nonzero",
		};
		const x6: OrchestratorState = {
			...waiting,
			phase: "failed",
			failureReason: "commit_unit_absent_on_resume",
		};
		const unsafe = fail(staging("a1"), "a1", "unsafe");
		const quarantined: OrchestratorState = { ...unsafe, phase: "quarantined" };
		for (const state of [packageFailure, x6, quarantined])
			expect(reduceOrchestrator(state, event)).toBe(state);
	});

	test("legacy migration accepts only the exact pre-metadata RAUC failure", () => {
		const legacy: OrchestratorState = {
			...initialOrchestratorState(0),
			phase: "failed",
			failureReason: "rauc_install_failed",
		};
		const event = {
			type: "OS_STAGE_LEGACY_FAILURE_MIGRATED",
			now: 5,
			retryAt: 5 + 15 * MIN,
		} as const;
		const migrated = reduceOrchestrator(legacy, event);
		expect(migrated.phase).toBe("idle");
		expect(migrated.failureReason).toBeNull();
		expect(migrated.osCheck.nextAttemptAt).toBe(5 + 15 * MIN);
		for (const reason of [
			"rauc_install_failed_extra",
			"commit_unit_absent_on_resume",
			"os_stage_outcome_unknown_after_restart",
		]) {
			const other = { ...legacy, failureReason: reason };
			expect(reduceOrchestrator(other, event)).toBe(other);
		}
		const withRecord = fail(staging("a1"), "a1", "unsafe");
		const relabelled = { ...withRecord, failureReason: "rauc_install_failed" };
		expect(reduceOrchestrator(relabelled, event)).toBe(relabelled);
	});
});
