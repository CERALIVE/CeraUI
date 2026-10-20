import { afterEach, expect, test } from "bun:test";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { startUpdateOrchestrator } from "../modules/system/update-orchestrator/runtime.ts";
import {
	GOOD_SLOTS,
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("aborts startup's final save when another backend replaces the unsafe attempt", async () => {
	// Given startup awaiting readiness for its original persisted attempt.
	const entered = Promise.withResolvers<void>();
	const evidence = Promise.withResolvers<typeof GOOD_SLOTS>();
	const f = runtimeFixture({
		readRootSlots: () => {
			entered.resolve();
			return evidence.promise;
		},
	});
	fixtures.push(f);
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	const startup = startUpdateOrchestrator(f.deps);
	await entered.promise;
	const record = identifiedState().osStageRecovery;
	if (!record) throw new Error("fixture record missing");
	const newer = {
		...identifiedState(),
		osStageRecovery: {
			...record,
			attemptId: "00000000-0000-4000-8000-000000000099",
		},
	};
	// When another backend persists a newer unsafe failure during that await.
	saveOrchestratorState(newer, f.file);
	evidence.resolve(GOOD_SLOTS);
	// Then the startup tail cannot persist its stale baseline over the newer attempt.
	await expect(startup).rejects.toHaveProperty(
		"reason",
		"rauc_recovery_unproven",
	);
	expect(await loadOrchestratorState(f.file)).toEqual(newer);
});
