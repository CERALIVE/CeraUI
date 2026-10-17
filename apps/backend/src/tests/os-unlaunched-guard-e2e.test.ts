import { afterEach, expect, test } from "bun:test";
import { readOsStageJob } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import {
	readOsUnlaunchedWitness,
	writeOsUnlaunchedWitness,
} from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import type { OrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { record } from "./helpers/os-stage-orphan-record.ts";
import { input } from "./helpers/os-stage-unlaunched-fixture.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";
import {
	D8_STATE,
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** The interrupted staging record exactly as the runtime persisted it for this attempt. */
function interrupted(attemptId = input.attemptId): OrchestratorState {
	const state = identifiedState();
	return {
		...state,
		phase: "os-staging",
		failureReason: null,
		osStageRecovery: {
			...state.osStageRecovery,
			candidateKey: state.osStageRecovery?.candidateKey ?? "",
			attemptId,
			activeAttemptId: attemptId,
			failedRounds: 0,
			nextRetryAt: null,
			mode: "automatic",
			reason: null,
		},
	};
}

/** Settles a held unlaunched guardian whose witness lands in the runtime's witness file. */
async function settleThroughGuard(f: ReturnType<typeof runtimeFixture>) {
	await using h = await unlaunchedHarness("live", {
		attemptId: input.attemptId,
		candidateKey: input.manifestJson,
		baseline: {
			...record.baseline,
			instance: input.baselineInstance,
			processes: [input.baselineInstance],
			bootId: input.bootId,
		},
	});
	await h.settle({
		witness: (witness) => writeOsUnlaunchedWitness(witness, f.witnessDeps),
	});
	expect(h.effects).toContain("normal-exit");
	expect(await readOsStageJob(h.directory, h.uid)).toBeNull();
}

test("a guard-written witness settles the interrupted attempt to one counted operator retry", async () => {
	// Given the guard proves and physically settles the unlaunched attempt.
	const f = runtimeFixture();
	fixtures.push(f);
	await settleThroughGuard(f);
	expect(readOsUnlaunchedWitness(f.witnessDeps)).toMatchObject({
		attemptId: input.attemptId,
		bootId: input.bootId,
		disposition: "unlaunched-unchanged",
	});
	setOrchestratorStateForTest(interrupted());
	saveOrchestratorState(interrupted(), f.file);
	setOrchestratorRuntimeDepsForTest(f.deps);
	// When the runtime's scheduling tick consumes the evidence.
	await runOrchestratorTick();
	// Then the attempt is a retryable operator failure counted exactly once.
	expect(getOrchestratorState()).toMatchObject({
		phase: "os-available",
		failureReason: "rauc_install_failed",
		osStageRecovery: {
			attemptId: input.attemptId,
			activeAttemptId: null,
			failedRounds: 1,
			mode: "operator",
			reason: "rauc_install_failed",
		},
	});
	expect(readOsUnlaunchedWitness(f.witnessDeps)).toBeNull();
});

test.each(["attempt", "boot", "legacy"] as const)(
	"a guard-written witness with a mismatching %s leaves the record unsafe",
	async (kind) => {
		// Given a physically settled attempt but provenance that does not match.
		const f = runtimeFixture(
			kind === "boot"
				? { readBootId: async () => "00000000-0000-4000-8000-000000000099" }
				: {},
		);
		fixtures.push(f);
		await settleThroughGuard(f);
		const state =
			kind === "legacy"
				? D8_STATE
				: kind === "attempt"
					? {
							...identifiedState(),
							osStageRecovery: {
								...identifiedState().osStageRecovery,
								candidateKey:
									identifiedState().osStageRecovery?.candidateKey ?? "",
								attemptId: "00000000-0000-4000-8000-000000000099",
								activeAttemptId: null,
								failedRounds: 1,
								nextRetryAt: null,
								mode: "unsafe" as const,
								reason: "rauc_recovery_unproven" as const,
							},
						}
					: identifiedState();
		setOrchestratorStateForTest(state);
		setOrchestratorRuntimeDepsForTest(f.deps);
		// When the runtime ticks.
		await runOrchestratorTick();
		// Then nothing transitions and no round is recounted.
		expect(getOrchestratorState()).toMatchObject({
			phase: state.phase,
			failureReason: state.failureReason,
			osStageRecovery: {
				failedRounds: state.osStageRecovery?.failedRounds,
				mode: state.osStageRecovery?.mode,
			},
		});
	},
);
