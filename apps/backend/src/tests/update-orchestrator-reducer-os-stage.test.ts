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
	test("staging persists the attempt identity before the attempt runs", () => {
		const state = staging("a1");
		expect(state.phase).toBe("os-staging");
		expect(state.osStageRecovery).toEqual({
			attemptId: "a1",
			candidateKey: KEY,
			activeAttemptId: "a1",
			failedRounds: 0,
			nextRetryAt: null,
			mode: "automatic",
			reason: null,
		});
	});

	test("an automatic failure returns to os-available with a 15-minute retry", () => {
		const state = fail(staging("a1"), "a1", "automatic");
		expect(state.phase).toBe("os-available");
		expect(state.progress).toBeNull();
		expect(state.failureReason).toBe("reason-automatic");
		expect(state.osStageRecovery).toMatchObject({
			activeAttemptId: null,
			failedRounds: 1,
			nextRetryAt: 1_000 + 15 * MIN,
			mode: "automatic",
		});
		expect(state.osCheck.nextAttemptAt).toBe(1_000 + 15 * MIN);
	});

	test("the second automatic failure waits 30 minutes and the third pauses for the operator", () => {
		let state = fail(staging("a1"), "a1", "automatic");
		state = fail(staging("a2", state), "a2", "automatic", 2_000);
		expect(state.phase).toBe("os-available");
		expect(state.osStageRecovery).toMatchObject({
			failedRounds: 2,
			nextRetryAt: 2_000 + 30 * MIN,
			mode: "automatic",
		});
		state = fail(staging("a3", state), "a3", "automatic", 3_000);
		expect(state.phase).toBe("os-available");
		expect(state.osStageRecovery).toMatchObject({
			failedRounds: 3,
			nextRetryAt: null,
			mode: "operator",
		});
	});

	test("an operator failure pauses OS staging without a global failure", () => {
		const state = fail(staging("a1"), "a1", "operator");
		expect(state.phase).toBe("os-available");
		expect(state.osStageRecovery).toMatchObject({
			failedRounds: 1,
			nextRetryAt: null,
			mode: "operator",
		});
	});

	test("an unsafe failure stays terminal with an unsafe record", () => {
		const state = fail(staging("a1"), "a1", "unsafe");
		expect(state.phase).toBe("failed");
		expect(state.failureReason).toBe("reason-unsafe");
		expect(state.osStageRecovery).toMatchObject({
			failedRounds: 1,
			activeAttemptId: null,
			mode: "unsafe",
		});
	});

	test("an untyped OS staging failure remains terminal", () => {
		const state = reduceOrchestrator(staging("a1"), {
			type: "OS_STAGING_FAILED",
			now: 5,
			reason: "rauc failed",
		});
		expect(state.phase).toBe("failed");
		expect(state.failureReason).toBe("rauc failed");
		expect(state.osStageRecovery?.mode).toBe("unsafe");
	});

	test("a settlement for another attempt is ignored, so a round counts once", () => {
		const live = staging("a2");
		expect(fail(live, "a1", "automatic")).toBe(live);
		const settled = fail(live, "a2", "automatic");
		expect(fail(settled, "a2", "automatic")).toBe(settled);
	});

	test("a stream cancellation ends the attempt without counting a round", () => {
		const waiting = fail(staging("a1"), "a1", "automatic");
		const state = reduceOrchestrator(staging("a2", waiting), {
			type: "OS_STAGING_ABORTED_FOR_STREAM",
			now: 2_000,
		});
		expect(state.phase).toBe("os-available");
		expect(state.osStageRecovery).toMatchObject({
			activeAttemptId: null,
			failedRounds: 1,
		});
	});

	test("success clears the recovery record", () => {
		const waiting = fail(staging("a1"), "a1", "automatic");
		const state = reduceOrchestrator(staging("a2", waiting), {
			type: "OS_STAGED",
			now: 3_000,
		});
		expect(state.phase).toBe("os-staged");
		expect(state.osStageRecovery).toBeUndefined();
	});

	test("a newly admitted candidate starts with a fresh budget", () => {
		const paused = fail(staging("a1"), "a1", "operator");
		const state = reduceOrchestrator(paused, {
			type: "OS_STAGING_STARTED",
			now: 20,
			attempt: { candidateKey: "other", attemptId: "b1" },
		});
		expect(state.osStageRecovery).toMatchObject({
			candidateKey: "other",
			failedRounds: 0,
			mode: "automatic",
		});
	});

	test("a package check never leaves os-available when no OS stage failed", () => {
		const offered: OrchestratorState = {
			...initialOrchestratorState(0),
			phase: "os-available",
		};
		expect(
			reduceOrchestrator(offered, { type: "PACKAGE_CHECK_STARTED", now: 1 }),
		).toBe(offered);
	});
});
