import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { syncOrchestratorDirectory } from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import { publishOsAttempt } from "../modules/system/update-orchestrator/os-attempt-publication.ts";
import { OsSettlementPersistence } from "../modules/system/update-orchestrator/os-settlement-persistence.ts";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
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
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});
async function offer() {
	const f = runtimeFixture();
	fixtures.push(f);
	setOrchestratorRuntimeDepsForTest(f.deps);
	await checkUpdatesNow();
	return f;
}

test("failure before intent write publishes no staging state or producer", async () => {
	// Given a private-store ownership failure before any intent publication.
	const f = await offer();
	const before = readFileSync(f.file);
	let stages = 0;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		osAttemptIntentStore: new OsAttemptIntentStore({
			...f.intentStore.storage,
			uid: f.intentStore.storage.uid + 1,
		}),
		stageOs: async () => {
			stages++;
		},
	});
	// When Install attempts pre-effect publication.
	await expect(installUpdatesNow()).rejects.toThrow();
	// Then agent.json is unchanged and no producer or intent exists.
	expect(readFileSync(f.file)).toEqual(before);
	expect(f.intentStore.read()).toBeNull();
	expect(stages).toBe(0);
});

test("restart recovers intent when agent publication failed before replacing baseline", async () => {
	// Given a durably written intent and failure before dispatch, then rollback storage failure.
	const f = await offer();
	const before = getOrchestratorState();
	await using lease = await acquireTestOsStageControl();
	expect(() =>
		publishOsAttempt(
			{
				manifest,
				lease,
				intentStore: f.intentStore,
				snapshot: () => before,
				dispatch: () => {
					throw new Error("agent pre-rename failure");
				},
				adopt: () => undefined,
				persist: () => {
					throw new Error("rollback pre-rename failure");
				},
			},
			{
				type: "OS_STAGING_STARTED",
				now: 1234,
				attempt: {
					candidateKey: osStageCandidateKey(manifest),
					attemptId: input.attemptId,
				},
			},
			new OsSettlementPersistence(),
		),
	).toThrow();
	expect(f.intentStore.read()?.phase).toBe("publishing");
	// When fresh runtime startup reads the baseline and intent.
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	// Then it restores the exact baseline without counting a failed round.
	expect(await loadOrchestratorState(f.file)).toEqual(before);
	expect(f.intentStore.read()).toBeNull();
});

test("stageOs sees durable launching authority under CONTROL before creating a producer", async () => {
	// Given a normal signed offer.
	const f = await offer();
	const before = getOrchestratorState();
	let observed = false;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		stageOs: async (candidate, _progress, control) => {
			const intent = f.intentStore.read();
			expect(intent).toMatchObject({
				phase: "launching",
				attemptId: control?.attemptId,
				manifest: candidate,
			});
			expect(control?.controlLease?.held()).toBe(true);
			expect(intent?.before.phase).toBe(before.phase);
			observed = true;
		},
	});
	// When Install crosses the producer boundary.
	expect((await installUpdatesNow()).started).toBe(true);
	// Then launched settlement retires only after agent durability.
	expect(observed).toBe(true);
	expect(f.intentStore.read()).toBeNull();
});

test("failed launching fsync with failed rollback remains unsafe across restart", async () => {
	// Given a launching rename whose parent fsync fails, then rollback cannot replace staging.
	const f = await offer();
	const store = new OsAttemptIntentStore({
		...f.intentStore.storage,
		syncParent: (path) => {
			if (JSON.parse(readFileSync(path, "utf8")).phase === "launching")
				throw new Error("launching fsync");
			syncOrchestratorDirectory(path);
		},
	});
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		osAttemptIntentStore: store,
		persist: (snapshot) => {
			if (snapshot.phase !== "os-staging")
				throw new Error("rollback pre-rename");
			saveOrchestratorState(snapshot, f.file);
		},
	});
	expect((await installUpdatesNow()).started).toBe(false);
	// When a restart cannot know whether launching crossed the effect boundary.
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	// Then it preserves launching instead of restoring the pre-state.
	expect(getOrchestratorState().phase).toBe("os-staging");
	expect(f.intentStore.read()?.phase).toBe("launching");
});
