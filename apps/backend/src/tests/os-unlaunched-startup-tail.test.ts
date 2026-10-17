import { afterEach, expect, test } from "bun:test";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { startUpdateOrchestrator } from "../modules/system/update-orchestrator/runtime.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const witnessResult of [
	"missing",
	"mismatched",
	"inconclusive",
] as const) {
	test(`startup cannot overwrite newer recovery when witness is ${witnessResult}`, async () => {
		// Given a baseline loaded before another backend publishes a newer attempt.
		const original = identifiedState();
		const newer = {
			...original,
			osStageRecovery: {
				...original.osStageRecovery,
				candidateKey: "newer",
				activeAttemptId: null,
				attemptId: "00000000-0000-4000-8000-000000000099",
				failedRounds: 2,
				nextRetryAt: null,
				mode: "unsafe" as const,
				reason: "rauc_recovery_unproven" as const,
			},
		};
		const f = runtimeFixture();
		fixtures.push(f);
		saveOrchestratorState(original, f.file);
		const deps = {
			...f.deps,
			readOsUnlaunchedWitness: () => {
				saveOrchestratorState(newer, f.file);
				if (witnessResult === "missing") return null;
				return {
					attemptId:
						witnessResult === "mismatched"
							? newer.osStageRecovery.attemptId
							: (original.osStageRecovery?.attemptId ?? ""),
					candidateKey: original.osStageRecovery?.candidateKey ?? "",
					bootId: "different-boot",
					baselineInstance: "1:1",
					disposition: "unlaunched-unchanged" as const,
				};
			},
		};
		// When startup reaches its final persistence boundary with stale memory.
		await expect(startUpdateOrchestrator(deps)).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
		// Then the authoritative newer failure is unchanged.
		expect(await loadOrchestratorState(f.file)).toEqual(newer);
	});
}

test("successful witness settlement has no second unprotected startup write", async () => {
	// Given a matching witness and a counted unsafe record.
	let writes = 0;
	const f = runtimeFixture({
		persist: (state) => {
			writes++;
			saveOrchestratorState(state, f.file);
		},
	});
	fixtures.push(f);
	saveOrchestratorState(identifiedState(), f.file);
	f.writeWitness();
	// When startup completes its durable settlement.
	await startUpdateOrchestrator(f.deps);
	// Then one write counts/settles the attempt; the tail adds no duplicate.
	const persisted = await loadOrchestratorState(f.file);
	expect(writes).toBe(1);
	expect(persisted?.osStageRecovery?.failedRounds).toBe(1);
	expect(persisted?.osStageRecovery?.mode).toBe("operator");
});
