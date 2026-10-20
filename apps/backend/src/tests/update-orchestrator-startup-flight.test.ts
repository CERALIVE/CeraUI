import { afterEach, expect, test } from "bun:test";
import { consumeOsUnlaunchedWitness } from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("joins overlapping startup and settles one witness once", async () => {
	// Given first startup held at a controlled readiness barrier.
	const entered = Promise.withResolvers<void>();
	const evidence = Promise.withResolvers<boolean>();
	let reconciliations = 0;
	let consumed = 0;
	const f = runtimeFixture({
		proveOsWriterQuiescent: () => {
			reconciliations++;
			entered.resolve();
			return evidence.promise;
		},
	});
	fixtures.push(f);
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	const deps = {
		...f.deps,
		consumeOsUnlaunchedWitness: (id: string) => {
			consumed++;
			consumeOsUnlaunchedWitness(id, f.witnessDeps);
		},
	};
	const first = startUpdateOrchestrator(deps);
	await entered.promise;
	// When another startup overlaps and both await the same readiness completion.
	const second = startUpdateOrchestrator(deps);
	evidence.resolve(true);
	await Promise.all([first, second]);
	await startUpdateOrchestrator(deps);
	// Then overlapping and already-started calls cannot double reconcile, settle or recount.
	expect(second).toBe(first);
	expect(reconciliations).toBe(1);
	expect(consumed).toBe(1);
	expect(getOrchestratorState().osStageRecovery).toMatchObject({
		mode: "operator",
		failedRounds: 1,
	});
});

test("joins package resume without changing the protected downloading startup block", async () => {
	// Given a persisted download with resume waiting at its recovery probe.
	const entered = Promise.withResolvers<void>();
	const recovery = Promise.withResolvers<boolean>();
	let probes = 0;
	const f = runtimeFixture({
		recoverSoftwareUpdateIfRunning: () => {
			probes++;
			entered.resolve();
			return recovery.promise;
		},
		lastInstallUnitVerdict: () => "absent",
	});
	fixtures.push(f);
	saveOrchestratorState(
		{ ...initialOrchestratorState(0), phase: "downloading" },
		f.file,
	);
	const first = startUpdateOrchestrator(f.deps);
	await entered.promise;
	// When another startup overlaps the visible downloading admission window.
	const second = startUpdateOrchestrator(f.deps);
	recovery.resolve(false);
	await Promise.all([first, second]);
	// Then only one unit reconciliation ran and its existing absence decision wins.
	expect(probes).toBe(1);
	expect(getOrchestratorState().phase).toBe("idle");
});
