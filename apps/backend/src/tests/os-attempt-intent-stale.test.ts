import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	fromPersisted,
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	attemptIntent,
	intentCrashFixture,
} from "./helpers/os-attempt-intent-fixture.ts";
import { record } from "./helpers/os-stage-startup-harness.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

function released(intent: ReturnType<typeof attemptIntent>) {
	return reduceOrchestrator(
		reduceOrchestrator(fromPersisted(intent.staged), {
			type: "OS_STAGED",
			now: 999,
			attemptId: intent.attemptId,
		}),
		{ type: "OS_STAGE_SETTLED", now: 999, attemptId: intent.attemptId },
	);
}

for (const state of ["cleared", "superseded"] as const) {
	test(`startup retires stale launching intent when its record is ${state} without restoring baseline`, async () => {
		// Given durable launching authority and an independently advanced disk record.
		const f = intentCrashFixture("launching");
		fixtures.push(f);
		const current =
			state === "cleared"
				? released(f.intent)
				: reduceOrchestrator(fromPersisted(f.intent.before), {
						type: "OS_STAGING_STARTED",
						now: 999,
						attempt: {
							candidateKey: osStageCandidateKey(f.intent.manifest),
							attemptId: "00000000-0000-4000-8000-000000000099",
						},
					});
		saveOrchestratorState(current, f.file);
		// When a fresh runtime proves no old producer survives.
		await startUpdateOrchestrator(f.deps);
		// Then only intent cleanup occurs; the newer state remains authoritative.
		expect(getOrchestratorState()).toEqual(current);
		expect(await loadOrchestratorState(f.file)).toEqual(current);
		expect(f.intentStore.read()).toBeNull();
	});
}

test("manual Install retires a stale launching intent and publishes the new attempt in the same admission", async () => {
	// Given a real discovered offer and a stale intent from another baseline.
	const f = runtimeFixture();
	fixtures.push(f);
	setOrchestratorRuntimeDepsForTest(f.deps);
	await checkUpdatesNow();
	f.intentStore.write({ ...attemptIntent(), phase: "launching" }, null);
	let stages = 0;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		stageOs: async (_manifest, _progress, control) => {
			stages++;
			expect(f.intentStore.read()?.attemptId).toBe(control?.attemptId);
			expect(control?.attemptId).toBe("00000000-0000-4000-8000-000000000003");
		},
	});
	// When Install runs once, without waiting for a scheduler tick.
	expect((await installUpdatesNow()).started).toBe(true);
	// Then the new producer runs and both terminal intent lifetimes end.
	expect(stages).toBe(1);
	expect(f.intentStore.read()).toBeNull();
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	expect(getOrchestratorState().phase).toBe("os-staged");
});

for (const barrier of [
	"job",
	"guardian",
	"witness",
	"unreadable-job",
	"unreadable-witness",
	"unreadable-guardian",
] as const) {
	test(`stale launching intent remains closed with ${barrier} ownership`, async () => {
		// Given a stale intent over a cleared record, but no conclusive ownership absence.
		const f = intentCrashFixture("launching");
		fixtures.push(f);
		saveOrchestratorState(released(f.intent), f.file);
		const deps = { ...f.deps };
		switch (barrier) {
			case "job":
				deps.readOsStageJob = async () => record;
				break;
			case "guardian":
				deps.osStageStartupDeps = {
					run: async () => ({
						exitCode: 0,
						stdout: "LoadState=loaded",
						stderr: "",
					}),
				};
				break;
			case "witness":
				f.writeWitness();
				break;
			case "unreadable-job":
				deps.readOsStageJob = async () => {
					throw new Error("job unreadable");
				};
				break;
			case "unreadable-witness":
				deps.readOsUnlaunchedWitness = () => {
					throw new Error("witness unreadable");
				};
				break;
			case "unreadable-guardian":
				deps.osStageStartupDeps = {
					run: async () => ({
						exitCode: 1,
						stdout: "",
						stderr: "guardian unreadable",
					}),
				};
				break;
		}
		const bytes = readFileSync(f.intentStore.storage.path);
		// When startup attempts stale cleanup.
		await expect(startUpdateOrchestrator(deps)).rejects.toThrow();
		// Then authority bytes survive and mutation readiness stays closed.
		expect(readFileSync(f.intentStore.storage.path)).toEqual(bytes);
		await expect(installUpdatesNow()).rejects.toMatchObject({
			data: { retryable: true },
		});
	});
}
