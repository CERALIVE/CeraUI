import { afterEach, expect, test } from "bun:test";
import {
	loadOrchestratorState,
	OrchestratorRecoveryLoadError,
	toPersisted,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("preserves the file and terminal reason when historical attempt identity is malformed", async () => {
	// Given parseable D8-shaped metadata with a malformed present attempt UUID.
	const f = runtimeFixture();
	fixtures.push(f);
	const state = identifiedState();
	const raw = JSON.stringify(
		toPersisted({
			...state,
			osStageRecovery: {
				...state.osStageRecovery,
				candidateKey: "candidate",
				activeAttemptId: null,
				failedRounds: 1,
				nextRetryAt: null,
				mode: "unsafe",
				reason: "rauc_recovery_unproven",
				attemptId: "attempt-a",
			},
		}),
	);
	await Bun.write(f.file, raw);
	await expect(loadOrchestratorState(f.file)).rejects.toBeInstanceOf(
		OrchestratorRecoveryLoadError,
	);
	// When production startup handles the existing H2-R2 terminal-load failure.
	await startUpdateOrchestrator(f.deps);
	// Then it never defaults to idle, repairs provenance or admits a stage.
	expect(getOrchestratorState()).toMatchObject({
		phase: "failed",
		failureReason: "rauc_recovery_unproven",
	});
	expect(await Bun.file(f.file).text()).toBe(raw);
	await expect(installUpdatesNow()).rejects.toHaveProperty(
		"code",
		"UPDATE_ORCHESTRATOR_INITIALIZING",
	);
});
