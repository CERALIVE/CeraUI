import { afterEach, expect, test } from "bun:test";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { input } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	GOOD_SLOTS,
	identifiedState,
	KEY,
	NOW,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const writer of ["interrupted", "confirmation", "legacy"] as const) {
	test(`${writer} replays the exact pending snapshot without redispatch or recount`, async () => {
		// Given an authoritative baseline and a fault before rename.
		const f = runtimeFixture();
		fixtures.push(f);
		const baseline =
			writer === "interrupted"
				? reduceOrchestrator(
						{ ...initialOrchestratorState(0), phase: "os-available" },
						{
							type: "OS_STAGING_STARTED",
							now: NOW,
							attempt: { candidateKey: KEY, attemptId: input.attemptId },
						},
					)
				: writer === "legacy"
					? {
							...initialOrchestratorState(0),
							phase: "failed" as const,
							failureReason: "rauc_install_failed",
						}
					: identifiedState();
		saveOrchestratorState(baseline, f.file);
		setOrchestratorStateForTest(baseline);
		let clock = NOW;
		let writes = 0;
		const snapshots: ReturnType<typeof getOrchestratorState>[] = [];
		const dependencies = {
			...f.deps,
			now: () => clock,
			readRootSlots: async () =>
				GOOD_SLOTS.map((slot) =>
					slot.state === "inactive"
						? { ...slot, bootStatus: "bad" as const }
						: slot,
				),
			persist: (snapshot: ReturnType<typeof getOrchestratorState>) => {
				snapshots.push(snapshot);
				if (++writes === 1) throw new Error("write before rename failed");
				f.deps.persist(snapshot);
			},
		};
		setOrchestratorRuntimeDepsForTest(dependencies);
		// When the settlement write fails, a manual confirmation is refused until replay.
		const action =
			writer === "confirmation" ? checkUpdatesNow() : runOrchestratorTick();
		await expect(action).rejects.toThrow("write before rename failed");
		const settled = getOrchestratorState();
		expect(await loadOrchestratorState(f.file)).toEqual(baseline);
		await expect(checkUpdatesNow()).rejects.toMatchObject({
			code: "UPDATE_ORCHESTRATOR_INITIALIZING",
			data: { retryable: true },
		});
		clock += 100_000;
		await runOrchestratorTick();
		// Then the saved intent is identical despite the new clock, with one successful write.
		expect(snapshots).toEqual([settled, settled]);
		expect(await loadOrchestratorState(f.file)).toEqual(settled);
		expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(
			writer === "legacy" ? undefined : 1,
		);
		expect((await checkUpdatesNow()).started).toBe(true);
	});
}
