import { afterEach, expect, test } from "bun:test";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("restart restores the exact pre-state when publication renamed but rollback never replaced it", async () => {
	// Given a real offer, a post-rename publication failure and a pre-rename rollback failure.
	const f = runtimeFixture();
	fixtures.push(f);
	setOrchestratorRuntimeDepsForTest(f.deps);
	await checkUpdatesNow();
	const before = getOrchestratorState();
	let stages = 0;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		stageOs: async () => {
			stages++;
		},
		persist: (snapshot) => {
			if (snapshot.phase !== "os-staging")
				throw new Error("rollback before rename");
			saveOrchestratorState(snapshot, f.file, () => {
				throw new Error("publication parent fsync");
			});
		},
	});
	expect((await installUpdatesNow()).started).toBe(false);
	expect((await loadOrchestratorState(f.file))?.phase).toBe("os-staging");
	// When a fresh runtime loses every volatile latch, using only the same disk.
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	// Then the phantom attempt never spends a round or raises unsafe policy.
	expect(getOrchestratorState()).toEqual(before);
	expect(await loadOrchestratorState(f.file)).toEqual(before);
	expect(stages).toBe(0);
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	expect(getOrchestratorState()).toEqual(before);
	expect((await checkUpdatesNow()).started).toBe(true);
	expect((await installUpdatesNow()).started).toBe(true);
});
