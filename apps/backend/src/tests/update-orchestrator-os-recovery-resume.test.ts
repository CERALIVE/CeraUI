/**
 * OS staging recovery across a restart and a manual recovery check: an
 * interrupted attempt is observed and never replayed, an unreadable probe
 * defers, and a failed record leaves `failed` only on positive OS evidence
 * (deb #5's persisted `failed / rauc_install_failed` is the legacy case).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	OS_STAGE_FIRST_RETRY_DELAY_MS,
	osStageNoticeId,
} from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { deps, dirs, tempDir } from "./helpers/os-recovery-resume-harness.ts";
import {
	KEY,
	NOW,
	PROOF,
	unsafeRecord,
} from "./helpers/os-recovery-resume-inputs.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("an attempt interrupted by a restart", () => {
	test("C-R3 a memory-only offer rediscovered after restart keeps its retry deadline", async () => {
		// Given a settled retry reloaded without the memory-only candidate.
		const calls = { stages: 0 };
		let now = NOW;
		setOrchestratorStateFilePathForTest(join(tempDir(), "agent.json"));
		saveOrchestratorState({
			...initialOrchestratorState(0),
			phase: "os-available",
			osStageRecovery: {
				...unsafeRecord(),
				mode: "automatic",
				reason: "os_transport_failed",
				nextRetryAt: NOW + OS_STAGE_FIRST_RETRY_DELAY_MS,
			},
		});
		await startUpdateOrchestrator(deps(PROOF, calls, { now: () => now }));
		await runOrchestratorTick();
		expect(calls.stages).toBe(0);
		expect(getOrchestratorState().phase).toBe("idle");
		// When idle reaches the retry deadline after rediscovery and package-none.
		now += OS_STAGE_FIRST_RETRY_DELAY_MS;
		await runOrchestratorTick();
		await runOrchestratorTick();
		// Then the persisted deadline, not normal check cadence, admits one stage.
		expect(calls.stages).toBe(1);
	});

	const interrupted: OrchestratorState = {
		...initialOrchestratorState(0),
		phase: "os-staging",
		osStageRecovery: {
			candidateKey: KEY,
			activeAttemptId: "attempt-1",
			failedRounds: 0,
			nextRetryAt: null,
			mode: "automatic",
			reason: null,
		},
	};

	test("is observed while RAUC still runs, never replayed", async () => {
		const calls = { stages: 0 };
		setOrchestratorRuntimeDepsForTest(
			deps({ ...PROOF, operation: "running" }, calls),
		);
		setOrchestratorStateForTest(interrupted);
		await runOrchestratorTick();
		expect(getOrchestratorState()).toEqual(interrupted);
		expect(calls.stages).toBe(0);
	});

	test("defers when the RAUC probe is unreadable", async () => {
		const calls = { stages: 0 };
		setOrchestratorRuntimeDepsForTest(
			deps({ ...PROOF, operation: "unreadable" }, calls),
		);
		setOrchestratorStateForTest(interrupted);
		await expect(runOrchestratorTick()).rejects.toThrow(
			"rauc_operation_unknown",
		);
		expect(getOrchestratorState()).toEqual(interrupted);
	});

	test("settles once as an unsafe round when RAUC is idle, and says so", async () => {
		const calls = { stages: 0 };
		setOrchestratorStateFilePathForTest(join(tempDir(), "agent.json"));
		saveOrchestratorState(interrupted);
		setOrchestratorRuntimeDepsForTest(deps(PROOF, calls));
		setOrchestratorStateForTest(interrupted);
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe(
			"os_stage_outcome_unknown_after_restart",
		);
		expect(getOrchestratorState().osStageRecovery).toMatchObject({
			activeAttemptId: null,
			failedRounds: 1,
			mode: "unsafe",
		});
		expect(
			getPersistentNotifications(true).show.map((notice) => notice.name),
		).toContain(`update:os-stage-unresolved:${osStageNoticeId(KEY)}`);
		await runOrchestratorTick();
		expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(1);
		expect(calls.stages).toBe(0);
	});
});
