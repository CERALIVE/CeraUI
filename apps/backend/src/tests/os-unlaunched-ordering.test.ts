import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { updateOrchestratorPersistedStateSchema } from "@ceraui/rpc/schemas";
import {
	consumeOsUnlaunchedWitness,
	readOsUnlaunchedWitness,
	writeOsUnlaunchedWitness,
} from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
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
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	identifiedState,
	KEY,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});
function fixture() {
	const f = runtimeFixture();
	fixtures.push(f);
	return f;
}

test("consumes only after agent.json is persisted when the interrupted attempt settles", async () => {
	// Given an uncounted interrupted attempt with physical-settlement evidence.
	const f = fixture();
	f.writeWitness();
	const interrupted = {
		...identifiedState(),
		phase: "os-staging" as const,
		failureReason: null,
		osStageRecovery: {
			candidateKey: KEY,
			attemptId: input.attemptId,
			activeAttemptId: input.attemptId,
			failedRounds: 0,
			nextRetryAt: null,
			mode: "automatic" as const,
			reason: null,
		},
	};
	saveOrchestratorState(interrupted, f.file);
	const observations: string[] = [];
	// When startup settles, capture the persisted outcome at the consume boundary.
	await startUpdateOrchestrator({
		...f.deps,
		persist: (state) => {
			observations.push(state.phase);
			if (observations.length === 1)
				expect(readOsUnlaunchedWitness(f.witnessDeps)).not.toBeNull();
			saveOrchestratorState(state, f.file);
		},
		consumeOsUnlaunchedWitness: (attemptId) => {
			const disk = updateOrchestratorPersistedStateSchema.parse(
				JSON.parse(readFileSync(f.file, "utf8")),
			);
			expect(disk).toMatchObject({
				phase: "os-available",
				osStageRecovery: { failedRounds: 1, attemptId },
			});
			observations.push("consume");
			consumeOsUnlaunchedWitness(attemptId, f.witnessDeps);
		},
	});
	// Then unsafe was never persisted, and persistence preceded consumption.
	expect(observations.slice(0, 2)).toEqual(["os-available", "consume"]);
	expect(observations).not.toContain("failed");
});

test("counts once after a pre-persist crash when interrupted staging is retried on startup", async () => {
	// Given staging with zero failed rounds before a simulated write failure.
	const f = fixture();
	f.writeWitness();
	saveOrchestratorState(
		{
			...identifiedState(),
			phase: "os-staging",
			failureReason: null,
			osStageRecovery: {
				candidateKey: KEY,
				attemptId: input.attemptId,
				activeAttemptId: input.attemptId,
				failedRounds: 0,
				nextRetryAt: null,
				mode: "automatic",
				reason: null,
			},
		},
		f.file,
	);
	// When settlement dies before persistence and another backend starts.
	await expect(
		startUpdateOrchestrator({
			...f.deps,
			persist: () => {
				throw new Error("write fault");
			},
		}),
	).rejects.toThrow("write fault");
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	// Then the same attempt contributes one round, not two.
	expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(1);
});

test("invalidates a stale same-candidate witness before a newer attempt receives control", async () => {
	// Given a witness left after safe settlement, followed by a manual retry.
	const f = fixture();
	setOrchestratorRuntimeDepsForTest(f.deps);
	await checkUpdatesNow();
	f.writeWitness();
	let observed = false;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		stageOs: async (_manifest, _progress, control) => {
			observed = true;
			expect(readOsUnlaunchedWitness(f.witnessDeps)).toBeNull();
			expect(getOrchestratorState().osStageRecovery?.attemptId).toBe(
				control?.attemptId,
			);
			expect(control?.attemptId).not.toBe(input.attemptId);
			throw new Error("stage stopped for fixture");
		},
	});
	// When a new same-candidate attempt starts.
	await installUpdatesNow();
	// Then the old witness could not survive into the new attempt's unsafe outcome.
	expect(observed).toBe(true);
});

test("retires an unmatched other-candidate witness so the next attempt's guard can write its own", async () => {
	// Given a witness for another candidate that no persisted identity can match.
	const f = fixture();
	setOrchestratorRuntimeDepsForTest(f.deps);
	await checkUpdatesNow();
	const other = { ...manifest, version: "2026.10.50", serial: 12 };
	writeOsUnlaunchedWitness(
		{ ...input, manifestJson: JSON.stringify(other) },
		f.witnessDeps,
	);
	let written = false;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		stageOs: async (_manifest, _progress, control) => {
			writeOsUnlaunchedWitness(
				{ ...input, attemptId: control?.attemptId ?? "" },
				f.witnessDeps,
			);
			written = true;
			throw new Error("stage stopped for fixture");
		},
	});
	// When a new attempt starts.
	await installUpdatesNow();
	// Then the new attempt's witness write is not refused by the leftover file.
	expect(written).toBe(true);
	expect(readOsUnlaunchedWitness(f.witnessDeps)?.attemptId).toBe(
		"00000000-0000-4000-8000-000000000003",
	);
});

test("repersists adopted settlement before cleanup when a failed write is retried in-process", async () => {
	// Given dispatch adopted safe memory but its persistence failed.
	const f = fixture();
	f.writeWitness();
	setOrchestratorStateForTest(identifiedState());
	saveOrchestratorState(identifiedState(), f.file);
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		persist: () => {
			throw new Error("write fault");
		},
	});
	await expect(runOrchestratorTick()).rejects.toThrow("write fault");
	// When the same runtime retries with working persistence.
	setOrchestratorRuntimeDepsForTest(f.deps);
	await runOrchestratorTick();
	// Then cleanup follows a durable safe state, without a second round.
	expect(
		updateOrchestratorPersistedStateSchema.parse(
			JSON.parse(readFileSync(f.file, "utf8")),
		),
	).toMatchObject({
		phase: "os-available",
		osStageRecovery: { failedRounds: 1 },
	});
	expect(readOsUnlaunchedWitness(f.witnessDeps)).toBeNull();
});
