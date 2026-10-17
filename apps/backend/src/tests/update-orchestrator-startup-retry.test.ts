import { afterEach, expect, test } from "bun:test";
import {
	guardNonCritical,
	retainUpdatePhysicalReconciliation,
} from "../helpers/boot-guard.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { consumeOsUnlaunchedWitness } from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	allowCellularOnce,
	checkUpdatesNow,
	getOrchestratorState,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	retainUpdatePhysicalReconciliation(Promise.resolve(true));
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

test("waits for physical CONTROL reconciliation while mutations remain closed", async () => {
	// Given a physical reconciler retaining CONTROL until its completion promise.
	const physical = Promise.withResolvers<boolean>();
	void guardNonCritical("update-route-sweep", async () => {
		await physical.promise;
	});
	let held = true;
	let acquisitions = 0;
	const f = runtimeFixture({
		acquireOsStageControl: async () => {
			acquisitions++;
			if (held) throw new OsStageError("os_update_lock_held");
			return acquireTestOsStageControl();
		},
	});
	fixtures.push(f);
	saveOrchestratorState(initialOrchestratorState(0), f.file);
	// When startup overlaps that reconciliation.
	const first = startUpdateOrchestrator(f.deps);
	const second = startUpdateOrchestrator(f.deps);
	await expect(checkUpdatesNow()).rejects.toMatchObject({
		data: { retryable: true },
	});
	expect(acquisitions).toBe(0);
	held = false;
	physical.resolve(true);
	await first;
	// Then it joins one ordered startup, rather than swallowing lock contention.
	expect(second).toBe(first);
	expect(acquisitions).toBe(1);
	expect(() => allowCellularOnce("ready")).not.toThrow();
});

test("retries a transient startup persistence failure and then opens readiness", async () => {
	// Given an idle baseline and one failing tail write.
	const delays: number[] = [];
	const f = runtimeFixture();
	fixtures.push(f);
	let writes = 0;
	const runtimeDeps = {
		...f.deps,
		startupRetryClock: {
			wait: async (ms: number) => {
				delays.push(ms);
			},
		},
		persist: (state: Parameters<typeof saveOrchestratorState>[0]) => {
			if (++writes === 1) throw new Error("transient storage fault");
			f.deps.persist(state);
		},
	};
	// When startup's first save fails before rename.
	await startUpdateOrchestrator(runtimeDeps);
	// Then the internal bounded retry succeeds without an operator-triggered restart.
	expect(delays).toEqual([250]);
	expect(writes).toBe(2);
	expect(() => allowCellularOnce("ready")).not.toThrow();
});

test("caps permanent CONTROL failures without a hot loop or reopening admission", async () => {
	// Given permanent CONTROL refusal and an injected cadence clock.
	const delays: number[] = [];
	let acquisitions = 0;
	const f = runtimeFixture({
		acquireOsStageControl: async () => {
			acquisitions++;
			throw new OsStageError("os_update_lock_held");
		},
		startupRetryClock: {
			wait: async (ms) => {
				delays.push(ms);
			},
		},
	});
	fixtures.push(f);
	saveOrchestratorState(initialOrchestratorState(0), f.file);
	// When all bounded attempts fail.
	await expect(startUpdateOrchestrator(f.deps)).rejects.toBeInstanceOf(
		OsStageError,
	);
	// Then retries stop at six and the typed retryable gate remains closed.
	expect(acquisitions).toBe(6);
	expect(delays).toEqual([250, 500, 1000, 2000, 4000]);
	await expect(checkUpdatesNow()).rejects.toMatchObject({
		data: { retryable: true },
	});
});

for (const fault of ["persist", "consume"] as const) {
	test(`startup recovers a transient witness ${fault} failure without recounting`, async () => {
		// Given a matching witness whose first durability or cleanup operation fails.
		const f = runtimeFixture();
		fixtures.push(f);
		f.writeWitness();
		saveOrchestratorState(identifiedState(), f.file);
		let failures = 0;
		const delays: number[] = [];
		const dependencies = {
			...f.deps,
			startupRetryClock: {
				wait: async (ms: number) => {
					delays.push(ms);
				},
			},
			persist: (snapshot: ReturnType<typeof getOrchestratorState>) => {
				if (fault === "persist" && failures++ === 0)
					throw new Error("transient persist fault");
				f.deps.persist(snapshot);
			},
			consumeOsUnlaunchedWitness: (attemptId: string) => {
				if (fault === "consume" && failures++ === 0)
					throw new Error("transient consume fault");
				consumeOsUnlaunchedWitness(attemptId, f.witnessDeps);
			},
		};
		// When the internal startup flight retries that transient failure.
		await startUpdateOrchestrator(dependencies);
		// Then one failed round and the same attempt survive; readiness opens after cleanup.
		expect(delays).toEqual([250]);
		expect(getOrchestratorState().osStageRecovery).toMatchObject({
			failedRounds: 1,
			mode: "operator",
			attemptId: identifiedState().osStageRecovery?.attemptId,
		});
		expect(() => allowCellularOnce("ready")).not.toThrow();
	});
}
