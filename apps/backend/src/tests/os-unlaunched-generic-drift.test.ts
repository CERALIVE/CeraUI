import { afterEach, expect, test } from "bun:test";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	GOOD_SLOTS,
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const writer of ["confirmation", "interrupted", "legacy"] as const) {
	test(`${writer} cannot apply old evidence to a newer persisted attempt`, async () => {
		// Given an evidence read whose completion is controlled independently of disk.
		const entered = Promise.withResolvers<void>();
		const evidence = Promise.withResolvers<boolean>();
		let gated = writer === "legacy";
		const original = identifiedState();
		const initial =
			writer === "legacy"
				? {
						...initialOrchestratorState(0),
						phase: "failed" as const,
						failureReason: "rauc_install_failed",
					}
				: writer === "interrupted"
					? {
							...original,
							phase: "os-staging" as const,
							failureReason: null,
							osStageRecovery: {
								...original.osStageRecovery,
								candidateKey: original.osStageRecovery?.candidateKey ?? "",
								attemptId: original.osStageRecovery?.attemptId ?? "",
								activeAttemptId: original.osStageRecovery?.attemptId ?? "",
								failedRounds: 0,
								nextRetryAt: null,
								mode: "automatic" as const,
								reason: null,
							},
						}
					: original;
		const f = runtimeFixture({
			readOsUnlaunchedWitness: () => null,
			readRootSlots: async () =>
				GOOD_SLOTS.map((slot) =>
					slot.state === "inactive" ? { ...slot, bootStatus: "bad" } : slot,
				),
			proveOsWriterQuiescent: () => {
				if (!gated) return Promise.resolve(true);
				entered.resolve();
				return evidence.promise;
			},
		});
		fixtures.push(f);
		saveOrchestratorState(initial, f.file);
		const startup = startUpdateOrchestrator(f.deps);
		if (writer !== "legacy") await startup;
		gated = true;
		const action =
			writer === "legacy"
				? startup
				: writer === "confirmation"
					? checkUpdatesNow()
					: runOrchestratorTick();
		await entered.promise;
		const newer = {
			...original,
			osStageRecovery: {
				...original.osStageRecovery,
				candidateKey: "replacement",
				activeAttemptId: null,
				attemptId: "00000000-0000-4000-8000-000000000099",
				failedRounds: 2,
				nextRetryAt: null,
				mode: "unsafe" as const,
				reason: "rauc_recovery_unproven" as const,
			},
		};
		// When a simulated second backend changes agent.json before old evidence lands.
		saveOrchestratorState(newer, f.file);
		evidence.resolve(true);
		await expect(action).rejects.toHaveProperty(
			"reason",
			"rauc_recovery_unproven",
		);
		// Then no dispatch adopts or persists the stale recovery/terminal transition.
		expect(await loadOrchestratorState(f.file)).toEqual(newer);
		expect(getOrchestratorState().phase).toBe(initial.phase);
	});
}
