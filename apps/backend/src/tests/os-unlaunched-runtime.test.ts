import { afterEach, expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	readOsUnlaunchedWitness,
	writeOsUnlaunchedWitness,
} from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
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
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	D8_STATE,
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function fixture(overrides: Parameters<typeof runtimeFixture>[0] = {}) {
	const f = runtimeFixture(overrides);
	fixtures.push(f);
	return f;
}

test("settles to operator retry on startup when the same-boot witness matches an identified unsafe record", async () => {
	// Given a good inactive target and an identified, already-counted D8-shaped record.
	const f = fixture();
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	// When the real runtime starts.
	await startUpdateOrchestrator(f.deps);
	// Then agent.json is retryable, counted once, and the witness is retired.
	expect(await loadOrchestratorState(f.file)).toMatchObject({
		phase: "os-available",
		failureReason: "rauc_install_failed",
		osStageRecovery: { failedRounds: 1, mode: "operator" },
	});
	expect(readOsUnlaunchedWitness(f.witnessDeps)).toBeNull();
});

test.each(["startup", "tick", "manual-check", "manual-install"] as const)(
	"settles when admitted through %s",
	async (path) => {
		// Given the same unsafe attempt, with new installs disabled independently.
		const f = fixture({
			loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		});
		f.writeWitness();
		saveOrchestratorState(identifiedState(), f.file);
		setOrchestratorRuntimeDepsForTest(f.deps);
		setOrchestratorStateForTest(identifiedState());
		// When the chosen public runtime path observes settlement.
		switch (path) {
			case "startup":
				await startUpdateOrchestrator(f.deps);
				break;
			case "tick":
				await runOrchestratorTick();
				break;
			case "manual-check":
				await checkUpdatesNow();
				break;
			case "manual-install":
				await installUpdatesNow();
				break;
		}
		// Then unsafe policy clears without another failed round.
		expect(getOrchestratorState().osStageRecovery).toMatchObject({
			failedRounds: 1,
			mode: "operator",
			reason: "rauc_install_failed",
		});
		expect(readOsUnlaunchedWitness(f.witnessDeps)).toBeNull();
	},
);

test("settles interrupted staging directly when a completed witness is present", async () => {
	// Given an interrupted attempt not yet counted.
	const f = fixture();
	f.writeWitness();
	const state = identifiedState();
	setOrchestratorStateForTest({
		...state,
		phase: "os-staging",
		failureReason: null,
		osStageRecovery: {
			candidateKey: input.manifestJson,
			...state.osStageRecovery,
			activeAttemptId: input.attemptId,
			failedRounds: 0,
			nextRetryAt: null,
			mode: "automatic",
			reason: null,
		},
	});
	setOrchestratorRuntimeDepsForTest(f.deps);
	// When the scheduling tick settles the interrupted attempt.
	saveOrchestratorState(getOrchestratorState(), f.file);
	await runOrchestratorTick();
	// Then it never records an intermediate unsafe outcome.
	expect(getOrchestratorState()).toMatchObject({
		phase: "os-available",
		osStageRecovery: { failedRounds: 1, mode: "operator" },
	});
});

test.each([
	"missing",
	"attempt",
	"candidate",
	"boot",
	"legacy",
	"invalid",
] as const)("retains unsafe behavior when witness is %s", async (kind) => {
	// Given a legacy or identified unsafe record with insufficient provenance.
	const f = fixture();
	let state = identifiedState();
	switch (kind) {
		case "missing":
			break;
		case "attempt":
			writeOsUnlaunchedWitness(
				{ ...input, attemptId: "00000000-0000-4000-8000-000000000099" },
				f.witnessDeps,
			);
			break;
		case "candidate":
			writeOsUnlaunchedWitness(
				{ ...input, manifestJson: JSON.stringify({ ...manifest, serial: 14 }) },
				f.witnessDeps,
			);
			break;
		case "boot":
			writeOsUnlaunchedWitness(
				{ ...input, bootId: "00000000-0000-4000-8000-000000000099" },
				f.witnessDeps,
			);
			break;
		case "legacy":
			state = D8_STATE;
			f.writeWitness();
			break;
		case "invalid":
			f.deps = {
				...f.deps,
				readOsUnlaunchedWitness: () => {
					throw new OsStageError("rauc_recovery_unproven");
				},
			};
			break;
	}
	saveOrchestratorState(state, f.file);
	// When startup consumes available evidence.
	await startUpdateOrchestrator(f.deps);
	// Then no transition or failed-round change occurs, including the real D8 record.
	expect(getOrchestratorState()).toEqual(state);
});

test("retains the witness when persistence fails before durable settlement", async () => {
	// Given a completed witness with persistence failing before the write.
	const f = fixture();
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	// When startup's transition write fails.
	await expect(
		startUpdateOrchestrator({
			...f.deps,
			persist: () => {
				throw new Error("persist fault");
			},
		}),
	).rejects.toThrow("persist fault");
	// Then disk remains unsafe; a later startup settles exactly once.
	expect((await loadOrchestratorState(f.file))?.phase).toBe("failed");
	expect(readOsUnlaunchedWitness(f.witnessDeps)?.attemptId).toBe(
		input.attemptId,
	);
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(1);
});

test("replays cleanup without counting when consumption fails after persistence", async () => {
	// Given an unlink fault after agent.json's settlement write.
	const f = fixture();
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	// When consumption fails in the persisted-safe crash window.
	await expect(
		startUpdateOrchestrator({
			...f.deps,
			consumeOsUnlaunchedWitness: () => {
				throw new Error("consume fault");
			},
		}),
	).rejects.toThrow("consume fault");
	// Then the next startup only retires the surviving witness.
	expect((await loadOrchestratorState(f.file))?.phase).toBe("os-available");
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(1);
	expect(readOsUnlaunchedWitness(f.witnessDeps)).toBeNull();
});

test("rejects stale settlement when state generation moves across the evidence await", async () => {
	// Given a probe held by a controlled promise barrier.
	const gate = Promise.withResolvers<boolean>();
	const entered = Promise.withResolvers<void>();
	const f = fixture({
		proveOsWriterQuiescent: () => {
			entered.resolve();
			return gate.promise;
		},
	});
	f.writeWitness();
	setOrchestratorRuntimeDepsForTest(f.deps);
	setOrchestratorStateForTest(identifiedState());
	const tick = runOrchestratorTick();
	await entered.promise;
	const replacement = { ...identifiedState(), enteredAt: 99 };
	setOrchestratorStateForTest(replacement);
	// When the older observation finally answers.
	gate.resolve(true);
	await tick;
	// Then even an otherwise identical record remains untouched.
	expect(getOrchestratorState()).toBe(replacement);
	expect(readOsUnlaunchedWitness(f.witnessDeps)?.attemptId).toBe(
		input.attemptId,
	);
});
