import { afterEach, expect, test } from "bun:test";
import { readOsUnlaunchedWitness } from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { loadOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { input } from "./helpers/os-stage-unlaunched-fixture.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("keeps the captured legacy D8 state unsafe when a candidate-matching witness exists", async () => {
	// Given the captured agent bytes, not an object rewritten by the state serializer.
	const f = runtimeFixture();
	fixtures.push(f);
	const capture = await Bun.file(
		`${import.meta.dir}/fixtures/real-device/opi-d8-agent.txt`,
	).text();
	const marker = "##### agent.json\n";
	const bytes = capture.slice(
		capture.indexOf(marker) + marker.length,
		capture.indexOf("\n##### end"),
	);
	await Bun.write(f.file, bytes);
	f.writeWitness();
	let consumed = 0;
	const loaded = await loadOrchestratorState(f.file);
	if (!loaded) throw new Error("captured D8 state was not loaded");
	// When the real production loader and startup reconcile the matching witness.
	await startUpdateOrchestrator({
		...f.deps,
		consumeOsUnlaunchedWitness: () => {
			consumed++;
		},
	});
	// Then the missing attempt provenance remains unsafe and is not counted again or consumed.
	expect(loaded).toMatchObject({
		phase: "failed",
		failureReason: "rauc_recovery_unproven",
		osStageRecovery: { mode: "unsafe", failedRounds: 1 },
	});
	expect(loaded?.osStageRecovery?.attemptId).toBeUndefined();
	expect(getOrchestratorState()).toEqual(loaded);
	expect(consumed).toBe(0);
	expect(readOsUnlaunchedWitness(f.witnessDeps)?.attemptId).toBe(
		input.attemptId,
	);
});
