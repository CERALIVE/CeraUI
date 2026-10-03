/**
 * OS staging recovery across a restart and a manual recovery check: an
 * interrupted attempt is observed and never replayed, an unreadable probe
 * defers, and a failed record leaves `failed` only on positive OS evidence
 * (deb #5's persisted `failed / rauc_install_failed` is the legacy case).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { OS_STAGE_FIRST_RETRY_DELAY_MS } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import {
	bootFrom,
	deps,
	dirs,
	tempDir,
} from "./helpers/os-recovery-resume-harness.ts";
import {
	type Evidence,
	LEGACY_R6,
	NOW,
	PROOF,
	R6_SLOTS,
} from "./helpers/os-recovery-resume-inputs.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("the legacy r6 OS failure", () => {
	test("C-R6 check-now retains the migrated delay through discovery and a restart", async () => {
		// Given the exact legacy failure with positive settlement proof.
		const calls = { stages: 0 };
		let now = NOW;
		const runtimeDeps = deps(PROOF, calls, {
			now: () => now,
			persist: saveOrchestratorState,
		});
		setOrchestratorStateFilePathForTest(join(tempDir(), "agent.json"));
		saveOrchestratorState(LEGACY_R6);
		await startUpdateOrchestrator(runtimeDeps);
		// When check-now discovers the first candidate and the backend reloads it.
		await checkUpdatesNow();
		resetOrchestratorRuntimeForTest();
		await startUpdateOrchestrator(runtimeDeps);
		now = NOW + OS_STAGE_FIRST_RETRY_DELAY_MS - 1;
		await runOrchestratorTick();
		// Then discovery did not grant staging permission ahead of the persisted delay.
		expect(calls.stages).toBe(0);
		expect(getOrchestratorState().osStageRecovery?.nextRetryAt).toBe(
			NOW + OS_STAGE_FIRST_RETRY_DELAY_MS,
		);
	});

	test("migrates to fresh discovery with a delayed first retry on positive proof", async () => {
		const calls = await bootFrom(LEGACY_R6, PROOF);
		expect(getOrchestratorState().phase).toBe("idle");
		expect(getOrchestratorState().failureReason).toBeNull();
		expect(getOrchestratorState().osCheck.nextAttemptAt).toBe(
			NOW + OS_STAGE_FIRST_RETRY_DELAY_MS,
		);
		expect(calls.stages).toBe(0);
	});

	test.each([
		["RAUC is still running", { operation: "running" as const }],
		["RAUC is unreadable", { operation: "unreadable" as const }],
		["no writer quiescence proof", { quiescent: false }],
		["a staged receipt makes the outcome ambiguous", { receipt: true }],
		["an armed activation makes the outcome ambiguous", { armed: true }],
		[
			"the target slot reads good (possibly an unrecorded stage)",
			{
				slots: R6_SLOTS.map((slot) =>
					slot.state === "inactive" ? { ...slot, bootStatus: "good" } : slot,
				),
			},
		],
	])("stays failed when %s", async (_label, change) => {
		const calls = await bootFrom(LEGACY_R6, { ...PROOF, ...change });
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe("rauc_install_failed");
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("failed");
		expect(calls.stages).toBe(0);
	});

	test("no other failed reason migrates, even with full proof", async () => {
		for (const failureReason of [
			"commit_unit_absent_on_resume",
			"rauc_stage_failed",
			"slot-sync-unit-absent",
		]) {
			await bootFrom({ ...LEGACY_R6, failureReason }, PROOF);
			expect(getOrchestratorState().phase).toBe("failed");
			expect(getOrchestratorState().failureReason).toBe(failureReason);
			resetOrchestratorRuntimeForTest();
		}
	});

	test("a later tick migrates once the proof becomes readable", async () => {
		const evidence: Evidence = { ...PROOF, operation: "unreadable" };
		setOrchestratorStateFilePathForTest(join(tempDir(), "agent.json"));
		saveOrchestratorState(LEGACY_R6);
		await startUpdateOrchestrator(deps(evidence, { stages: 0 }));
		expect(getOrchestratorState().phase).toBe("failed");
		evidence.operation = "idle";
		await runOrchestratorTick();
		expect(getOrchestratorState().phase).toBe("idle");
	});
});
