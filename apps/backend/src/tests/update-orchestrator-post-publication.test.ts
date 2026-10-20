import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCHESTRATOR_PHASES } from "@ceraui/rpc/schemas";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	osStageCandidateKey,
	osStageNoticeId,
} from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	admitAndPrepareStreamStart,
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorEvent,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
import {
	cleanupRecovery,
	deferred,
	manifest,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";

afterEach(cleanupRecovery);

import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

test("H2-R1 never arms a published attempt whose producer was lost on restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-publication-resume-"));
	setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
	let arms = 0;
	try {
		saveOrchestratorState({
			...initialOrchestratorState(0),
			phase: "os-staged",
			osStageRecovery: {
				candidateKey: osStageCandidateKey(manifest),
				activeAttemptId: "lost-producer",
				failedRounds: 1,
				nextRetryAt: null,
				mode: "automatic",
				reason: null,
			},
		});
		await startUpdateOrchestrator({
			...defaultOrchestratorRuntimeDeps,
			acquireOsStageControl: acquireTestOsStageControl,
			startupRetryClock: { wait: () => Promise.resolve() },
			persist: saveOrchestratorState,
			isUpdateAdmissionReady: async () => true,
			inspectOsOperation: async () => "idle",
			proveOsWriterQuiescent: async () => true,
			armOs: async () => {
				arms++;
			},
		});
		await runOrchestratorTick();
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: "os_stage_outcome_unknown_after_restart",
		});
		expect(arms).toBe(0);
	} finally {
		resetOrchestratorRuntimeForTest();
		setOrchestratorStateFilePathForTest(null);
		rmSync(dir, { recursive: true });
	}
});

test.each([false, true])(
	"H2-R1 persists unsafe post-publication settlement with stream start=%s",
	async (streamStart) => {
		// Given a retry notice and a second producer parked AFTER its real commit callback.
		const dir = mkdtempSync(join(tmpdir(), "ceraui-post-publication-"));
		setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
		const published = deferred<void>();
		const finish = deferred<void>();
		let rounds = 0;
		let arms = 0;
		let receipt = false;
		let live = false;
		const harness = await recoveryHarness({
			persist: saveOrchestratorState,
			isStreamLive: () => live,
			armOs: async () => {
				arms++;
			},
			stageOs: async (_candidate, _progress, control) => {
				if (++rounds === 1) throw new OsStageError("os_transport_failed");
				receipt = true;
				control?.commit?.({
					schema: 1,
					version: manifest.version,
					channel: manifest.channel,
					stagedAt: 1,
					bootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				});
				published.resolve();
				await finish.promise;
				throw new OsStageError("rauc_recovery_unproven");
			},
		});
		await runOrchestratorTick();
		const install = installUpdatesNow();
		await published.promise;
		try {
			if (streamStart) {
				await admitAndPrepareStreamStart();
				live = true;
			}
			harness.clock.now += 60_000;
			await runOrchestratorTick();
			expect(arms).toBe(0);
			// When release reports unsafe ownership after publication.
			finish.resolve();
			expect(await install).toEqual({
				started: false,
				reason: "not_available",
			});
			// Then terminal policy survives persistence, replaces the retry and cannot arm.
			expect(getOrchestratorState()).toMatchObject({
				phase: "failed",
				failureReason: "rauc_recovery_unproven",
				osStageRecovery: {
					activeAttemptId: null,
					failedRounds: 2,
					mode: "unsafe",
					nextRetryAt: null,
				},
			});
			expect(await loadOrchestratorState()).toEqual(getOrchestratorState());
			const id = osStageNoticeId(osStageCandidateKey(manifest));
			const names = getPersistentNotifications(true).show.map(
				(notice) => notice.name,
			);
			expect(names).toContain(`update:os-stage-unresolved:${id}`);
			expect(names).not.toContain(`update:os-stage-retry:${id}`);
			expect(receipt).toBe(true);
			await runOrchestratorTick();
			expect(arms).toBe(0);
		} finally {
			finish.resolve();
			await install;
			setOrchestratorStateFilePathForTest(null);
			rmSync(dir, { recursive: true });
		}
	},
);

test("H2-R1 retains publication identity until the matching producer settles", () => {
	const staging: OrchestratorState = {
		...initialOrchestratorState(0),
		phase: "os-staging",
		osStageRecovery: {
			candidateKey: "k",
			activeAttemptId: "a",
			failedRounds: 1,
			nextRetryAt: null,
			mode: "automatic",
			reason: "os_transport_failed",
		},
	};
	const published = reduceOrchestrator(staging, {
		type: "OS_STAGED",
		now: 1,
		attemptId: "a",
	});
	expect(published.osStageRecovery).toEqual(staging.osStageRecovery);
	expect(
		reduceOrchestrator(published, { type: "OS_ACTIVATION_ARMED", now: 2 }),
	).toBe(published);
	const settled = reduceOrchestrator(published, {
		type: "OS_STAGE_SETTLED",
		now: 2,
		attemptId: "a",
	});
	expect(settled.osStageRecovery).toBeUndefined();
	expect(
		reduceOrchestrator(settled, { type: "OS_ACTIVATION_ARMED", now: 3 }).phase,
	).toBe("os-activation-armed");
});

test.each([...ORCHESTRATOR_PHASES])(
	"H2-R1 post-publication event legal pairs in %s",
	(phase) => {
		const state: OrchestratorState = {
			...initialOrchestratorState(0),
			phase,
			osStageRecovery: {
				candidateKey: "k",
				activeAttemptId: "a",
				failedRounds: 1,
				nextRetryAt: null,
				mode: "automatic",
				reason: null,
			},
		};
		const event: OrchestratorEvent = {
			type: "OS_STAGING_FAILED",
			now: 1,
			reason: "rauc_recovery_unproven",
			recovery: { attemptId: "a", mode: "unsafe" },
		};
		const next = reduceOrchestrator(state, event);
		if (phase === "os-staging" || phase === "os-staged") {
			expect(next.phase).toBe("failed");
			expect(next.osStageRecovery?.failedRounds).toBe(2);
		} else expect(next).toBe(state);
		for (const attemptId of ["other", "a"]) {
			const settlement = reduceOrchestrator(state, {
				type: "OS_STAGE_SETTLED",
				now: 1,
				attemptId,
			});
			if (phase === "os-staged" && attemptId === "a")
				expect(settlement.osStageRecovery).toBeUndefined();
			else expect(settlement).toBe(state);
		}
		expect(
			reduceOrchestrator(state, {
				...event,
				recovery: { attemptId: "other", mode: "unsafe" },
			}),
		).toBe(state);
		if (phase === "os-staged") {
			for (const mode of ["automatic", "operator"] as const)
				expect(
					reduceOrchestrator(state, {
						...event,
						recovery: { attemptId: "a", mode },
					}),
				).toBe(state);
		}
	},
);
