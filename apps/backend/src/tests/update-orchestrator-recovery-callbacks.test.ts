import { afterEach, expect, test } from "bun:test";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	osStageCandidateKey,
	osStageNoticeId,
} from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
import {
	cleanupRecovery,
	deferred,
	manifest,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";

afterEach(cleanupRecovery);

test("C-R7 generic terminal settlement withdraws only this candidate's retry notice", async () => {
	// Given an automatic failure notice plus another candidate and OS-check notices.
	let rounds = 0;
	await recoveryHarness({
		stageOs: async () => {
			throw ++rounds === 1
				? new OsStageError("os_transport_failed")
				: new Error("rauc failed");
		},
	});
	await runOrchestratorTick();
	const retry = `update:os-stage-retry:${osStageNoticeId(osStageCandidateKey(manifest))}`;
	notifyUpdate({
		kind: "os-stage-operator",
		id: "other-candidate",
		version: "2026.11.0",
	});
	notifyUpdate({
		kind: "refused",
		id: "os-check:serial_replayed",
		reason: "serial_replayed",
	});
	// When the next manual round fails with an untyped terminal exception.
	await installUpdatesNow();
	// Then the automatic-retry promise is withdrawn without cross-candidate/check clearance.
	const names = getPersistentNotifications(true).show.map(
		(notice) => notice.name,
	);
	expect(getOrchestratorState().phase).toBe("failed");
	expect(names).not.toContain(retry);
	expect(names).toContain("update:refused:os:2026.10.0");
	expect(names).toContain("update:os-stage-operator:other-candidate");
	expect(names).toContain("update:refused:os-check:serial_replayed");
});

test("C-R8 a retained first-attempt callback cannot advance replacement progress", async () => {
	// Given a failed first round whose progress callback outlives its promise.
	let rounds = 0;
	let firstProgress: ((percent: number) => void) | undefined;
	const started = deferred<void>();
	const done = deferred<void>();
	await recoveryHarness({
		stageOs: async (_candidate, progress) => {
			if (++rounds === 1) {
				firstProgress = progress;
				throw new OsStageError("os_transport_failed");
			}
			started.resolve();
			await done.promise;
		},
	});
	await runOrchestratorTick();
	const install = installUpdatesNow();
	await started.promise;
	expect(firstProgress).toBeFunction();
	try {
		// When the old callback fires while the replacement is staging.
		firstProgress?.(99);
		// Then the second attempt's progress remains its initial zero.
		expect(getOrchestratorState().progress?.percent).toBe(0);
		expect(getOrchestratorState().osStageRecovery?.activeAttemptId).toBe(
			"00000000-0000-4000-8000-000000000002",
		);
	} finally {
		done.resolve();
		await install;
	}
});
