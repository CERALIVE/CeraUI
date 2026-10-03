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
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { deps, dirs, tempDir } from "./helpers/os-recovery-resume-harness.ts";
import { PROOF, unsafeRecord } from "./helpers/os-recovery-resume-inputs.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("a manual recovery check of an unsafe OS record", () => {
	test("clears it on positive proof and hands the next round to the operator", async () => {
		const calls = { stages: 0 };
		setOrchestratorStateFilePathForTest(join(tempDir(), "agent.json"));
		setOrchestratorRuntimeDepsForTest(deps(PROOF, calls));
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "failed",
			failureReason: "rauc_recovery_unproven",
			osStageRecovery: unsafeRecord(),
		});
		saveOrchestratorState(getOrchestratorState());
		expect(await checkUpdatesNow()).toEqual({ started: true });
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(getOrchestratorState().osStageRecovery).toMatchObject({
			mode: "operator",
			failedRounds: 1,
		});
		await runOrchestratorTick();
		expect(calls.stages).toBe(0);
	});

	test("stays terminal without proof", async () => {
		setOrchestratorRuntimeDepsForTest(
			deps({ ...PROOF, quiescent: false }, { stages: 0 }),
		);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "failed",
			failureReason: "rauc_recovery_unproven",
			osStageRecovery: unsafeRecord(),
		});
		expect(await checkUpdatesNow()).toEqual({
			started: false,
			reason: "busy",
		});
		expect(getOrchestratorState().phase).toBe("failed");
	});

	test("never clears X6, a package failure or a quarantine", async () => {
		for (const state of [
			{
				...initialOrchestratorState(0),
				phase: "failed" as const,
				failureReason: "commit_unit_absent_on_resume",
				osStageRecovery: { ...unsafeRecord(), mode: "automatic" as const },
			},
			{
				...initialOrchestratorState(0),
				phase: "failed" as const,
				failureReason: "apt-exit-nonzero",
			},
			{
				...initialOrchestratorState(0),
				phase: "quarantined" as const,
				failureReason: "rauc_recovery_unproven",
				osStageRecovery: unsafeRecord(),
			},
		]) {
			setOrchestratorRuntimeDepsForTest(deps(PROOF, { stages: 0 }));
			setOrchestratorStateForTest(state);
			expect(await checkUpdatesNow()).toEqual({
				started: false,
				reason: "busy",
			});
			expect(getOrchestratorState()).toEqual(state);
			resetOrchestratorRuntimeForTest();
		}
	});
});
