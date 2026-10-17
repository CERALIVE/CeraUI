import { afterEach, expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	cleanupRecovery,
	RETRY_DELAY,
	recoveryHarness,
	T0,
} from "./helpers/os-recovery-harness.ts";

afterEach(cleanupRecovery);

test("C-R3 refresh then package-none still discovers and stages exactly once at the retry deadline", async () => {
	// Given one failure and a same-candidate check-now refresh before its deadline.
	let stages = 0;
	const h = await recoveryHarness({
		stageOs: async () => {
			if (++stages === 1) throw new OsStageError("os_transport_failed");
		},
	});
	await runOrchestratorTick();
	h.clock.now = T0 + 60_000;
	await checkUpdatesNow();
	const refreshedClock = getOrchestratorState().osCheck.nextAttemptAt;
	setOrchestratorStateForTest({
		...getOrchestratorState(),
		packageCheck: { ...getOrchestratorState().packageCheck, nextAttemptAt: 0 },
	});
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("idle");
	// When the idle scheduler reaches the persisted retry deadline.
	h.clock.now = T0 + RETRY_DELAY;
	await runOrchestratorTick();
	await runOrchestratorTick();
	// Then refresh has not replaced retry permission with the twelve-hour cadence.
	expect(h.calls.stages).toBe(2);
	expect(refreshedClock).toBe(T0 + RETRY_DELAY);
	expect(getOrchestratorState().phase).toBe("os-staged");
});

test("C-R3 idle discovery consults the persisted retry even when the discovery clock is later", async () => {
	// Given a settled retry in idle with a later successful discovery clock.
	let stages = 0;
	const h = await recoveryHarness({
		stageOs: async () => {
			if (++stages === 1) throw new OsStageError("os_transport_failed");
		},
	});
	await runOrchestratorTick();
	setOrchestratorStateForTest({
		...getOrchestratorState(),
		phase: "idle",
		osCheck: {
			...getOrchestratorState().osCheck,
			nextAttemptAt: T0 + 12 * 60 * 60_000,
		},
	});
	// When the retry deadline arrives independently of discovery's clock.
	h.clock.now = T0 + RETRY_DELAY;
	await runOrchestratorTick();
	await runOrchestratorTick();
	// Then a fresh discovery precedes the sole retry stage.
	expect(h.calls.checks).toBe(2);
	expect(h.calls.stages).toBe(2);
});
