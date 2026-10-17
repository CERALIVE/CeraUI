import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
	fromPersisted,
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	attemptIntent,
	intentCrashFixture,
} from "./helpers/os-attempt-intent-fixture.ts";
import { record as jobRecord } from "./helpers/os-stage-startup-harness.ts";
import type { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});
function crash(
	phase: "publishing" | "launching" = "publishing",
	disk: "before" | "staged" = "staged",
) {
	const f = intentCrashFixture(phase, disk);
	fixtures.push(f);
	return f;
}

for (const disk of ["before", "staged"] as const) {
	test(`startup restores publishing intent over ${disk} and a second restart is idempotent`, async () => {
		// Given a crash before effects with exact durable authority.
		const f = crash("publishing", disk);
		// When two fresh runtimes recover only the disk.
		await startUpdateOrchestrator(f.deps);
		expect(getOrchestratorState()).toEqual(fromPersisted(f.intent.before));
		resetOrchestratorRuntimeForTest();
		await startUpdateOrchestrator(f.deps);
		// Then exact history and permissions remain and authority is retired.
		expect(await loadOrchestratorState(f.file)).toEqual(
			fromPersisted(f.intent.before),
		);
		expect(f.intentStore.read()).toBeNull();
	});
}

test("launching intent left after durable rollback replays cleanup without a failed round", async () => {
	// Given the exact pre-state already restored durably, before intent retirement.
	const f = crash("launching", "before");
	// When fresh startup proves that no producer or receipt survives.
	await startUpdateOrchestrator(f.deps);
	// Then only cleanup is replayed; launching never authorizes restoring a staging state.
	expect(getOrchestratorState()).toEqual(fromPersisted(f.intent.before));
	expect(f.intentStore.read()).toBeNull();
});

test("publishing recovery preserves prior failed rounds and the exact retry deadline", async () => {
	// Given two earlier failures and a new attempt that never crossed launch.
	const f = crash("publishing", "before");
	const previous = f.intent.staged.osStageRecovery;
	if (!previous) throw new Error("fixture requires identified recovery");
	const intent = attemptIntent({
		...fromPersisted(f.intent.before),
		failureReason: "os_transport_failed",
		osStageRecovery: {
			...previous,
			activeAttemptId: null,
			failedRounds: 2,
			nextRetryAt: 987_654_321,
			reason: "os_transport_failed",
			attemptId: "00000000-0000-4000-8000-000000000098",
		},
	});
	f.intentStore.retire(f.intent);
	f.intentStore.write(intent, null);
	saveOrchestratorState(fromPersisted(intent.staged), f.file);
	// When fresh startup restores the publication baseline.
	await startUpdateOrchestrator(f.deps);
	// Then no third round, new deadline, grant loss or clock change is synthesized.
	expect(getOrchestratorState()).toEqual(fromPersisted(intent.before));
});

test("crash between launching advance and stageOs keeps unknown-after-restart policy", async () => {
	// Given launching authority, with no producer yet created.
	const f = crash("launching");
	// When startup and the interrupted-attempt owner observe quiescence.
	await startUpdateOrchestrator(f.deps);
	await runOrchestratorTick();
	// Then the intent cannot downgrade uncertainty into never-launched authority.
	expect(getOrchestratorState()).toMatchObject({
		phase: "failed",
		failureReason: "os_stage_outcome_unknown_after_restart",
		osStageRecovery: { mode: "unsafe", failedRounds: 1 },
	});
	await runOrchestratorTick();
	expect(f.intentStore.read()).toBeNull();
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(1);
});

for (const barrier of [
	"job",
	"guardian",
	"witness",
	"unreadable-job",
	"unreadable-witness",
	"unreadable-guardian",
	"quiescence",
	"receipt",
	"activation",
	"disk-drift",
]) {
	test(`publishing intent cannot restore across ${barrier} evidence`, async () => {
		// Given exact intent but contradictory or unreadable physical authority.
		const f = crash();
		const bytes = readFileSync(f.file);
		const deps = { ...f.deps };
		switch (barrier) {
			case "job":
				deps.readOsStageJob = async () => jobRecord;
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
					throw new Error("unreadable ownership");
				};
				break;
			case "unreadable-witness":
				deps.readOsUnlaunchedWitness = () => {
					throw new Error("unreadable witness");
				};
				break;
			case "unreadable-guardian":
				deps.osStageStartupDeps = {
					run: async () => ({
						exitCode: 1,
						stdout: "",
						stderr: "unreadable guardian",
					}),
				};
				break;
			case "quiescence":
				deps.proveOsWriterQuiescent = async () => false;
				break;
			case "receipt":
				deps.readOsReceipt = async () => ({
					schema: 1,
					version: f.intent.manifest.version,
					channel: "drill",
					stagedAt: 123,
					bootId: "00000000-0000-4000-8000-000000000004",
				});
				break;
			case "activation":
				deps.readActivationArmed = async () => true;
				break;
			case "disk-drift":
				deps.proveOsWriterQuiescent = async () => {
					writeFileSync(
						f.file,
						bytes.toString().replace('"enteredAt":456', '"enteredAt":789'),
					);
					return true;
				};
				break;
		}
		// When a new runtime tries to settle it.
		await expect(startUpdateOrchestrator(deps)).rejects.toThrow();
		// Then readiness stays closed, intent preserved and no rollback is guessed.
		expect(f.intentStore.read()).toEqual(f.intent);
		expect((await loadOrchestratorState(f.file))?.phase).toBe("os-staging");
		await expect(checkUpdatesNow()).rejects.toMatchObject({
			data: { retryable: true },
		});
		await expect(installUpdatesNow()).rejects.toMatchObject({
			data: { retryable: true },
		});
		if (barrier !== "disk-drift") expect(readFileSync(f.file)).toEqual(bytes);
	});
}
