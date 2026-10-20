import { afterEach, expect, test } from "bun:test";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("a previously admitted Check cannot leave replayable settlement when durability becomes pending", async () => {
	// Given manual admission already awaiting its independent readiness probe.
	const entered = Promise.withResolvers<void>();
	const admission = Promise.withResolvers<boolean>();
	let checks = 0;
	const f = runtimeFixture({
		runPackageCheck: async () => {
			checks++;
			return null;
		},
	});
	fixtures.push(f);
	saveOrchestratorState(identifiedState(), f.file);
	setOrchestratorStateForTest(identifiedState());
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		isUpdateAdmissionReady: () => {
			entered.resolve();
			return admission.promise;
		},
	});
	const check = checkUpdatesNow();
	await entered.promise;
	f.writeWitness();
	// When startup adopts the witness but its durable write fails before admission resolves.
	await expect(
		startUpdateOrchestrator({
			...f.deps,
			persist: () => {
				throw new Error("persist fault");
			},
		}),
	).rejects.toThrow("persist fault");
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		readRootSlots: async () => {
			throw new Error("inconclusive");
		},
	});
	admission.resolve(true);
	// Then Check is refused, and the operator state retains the exact replayable shape.
	expect(await check).toEqual({ started: false, reason: "busy" });
	expect(checks).toBe(0);
	expect(getOrchestratorState().phase).toBe("os-available");
	expect(getOrchestratorState().failureReason).toBe("rauc_install_failed");
	expect((await loadOrchestratorState(f.file))?.osStageRecovery?.mode).toBe(
		"unsafe",
	);
});
