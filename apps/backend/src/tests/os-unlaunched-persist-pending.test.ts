import { afterEach, expect, test } from "bun:test";
import { readOsUnlaunchedWitness } from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { input } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("keeps admission closed after failed persistence when fresh evidence becomes inconclusive", async () => {
	// Given a cached offer, unsafe disk state and a witness whose first settlement cannot persist.
	const f = runtimeFixture();
	fixtures.push(f);
	setOrchestratorRuntimeDepsForTest(f.deps);
	await checkUpdatesNow();
	saveOrchestratorState(identifiedState(), f.file);
	setOrchestratorStateForTest(identifiedState());
	f.writeWitness();
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		persist: () => {
			throw new Error("persist fault");
		},
	});
	await expect(runOrchestratorTick()).rejects.toThrow("persist fault");
	expect(getOrchestratorState().phase).toBe("os-available");
	let stages = 0;
	let consumed = 0;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		readRootSlots: async () => {
			throw new Error("inconclusive evidence");
		},
		isOsStageReady: async () => true,
		stageOs: async () => {
			stages++;
		},
		consumeOsUnlaunchedWitness: () => {
			consumed++;
		},
	});
	// When manual admission races a later inconclusive read, followed by a backend crash.
	const install = await installUpdatesNow();
	const check = await checkUpdatesNow();
	resetOrchestratorRuntimeForTest();
	// Then the durable unsafe record still has its recovery witness, with no new attempt dispatched.
	expect(install).toEqual({ started: false, reason: "busy" });
	expect(check).toEqual({ started: false, reason: "busy" });
	expect(stages).toBe(0);
	expect(consumed).toBe(0);
	expect((await loadOrchestratorState(f.file))?.osStageRecovery).toEqual(
		identifiedState().osStageRecovery,
	);
	expect(readOsUnlaunchedWitness(f.witnessDeps)?.attemptId).toBe(
		input.attemptId,
	);
	await startUpdateOrchestrator(f.deps);
	expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(1);
});

test("opens admission only after a later successful settlement persist", async () => {
	// Given an adopted operator record still pending durable publication.
	const f = runtimeFixture();
	fixtures.push(f);
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	setOrchestratorStateForTest(identifiedState());
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		persist: () => {
			throw new Error("persist fault");
		},
	});
	await expect(runOrchestratorTick()).rejects.toThrow("persist fault");
	// When a subsequent tick can prove and durably finish that same settlement.
	setOrchestratorRuntimeDepsForTest(f.deps);
	await runOrchestratorTick();
	// Then manual admission can proceed without recounting the old attempt.
	expect((await checkUpdatesNow()).started).toBe(true);
	expect(readOsUnlaunchedWitness(f.witnessDeps)).toBeNull();
	expect(
		(await loadOrchestratorState(f.file))?.osStageRecovery?.failedRounds,
	).toBe(1);
});
