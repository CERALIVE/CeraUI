import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { syncOrchestratorDirectory } from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import {
	fromPersisted,
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	allowCellularOnce,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { intentCrashFixture } from "./helpers/os-attempt-intent-fixture.ts";
import type { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";
import { startupCadenceClock } from "./helpers/startup-cadence-clock.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const entry of ["startup", "tick"] as const) {
	for (const site of ["restore", "stale", "settled"] as const) {
		for (const faultKind of ["unlink", "fsync"] as const) {
			test(`${entry} ${site} retirement retains ${faultKind} acknowledgement until repair`, async () => {
				// Given real crash authority at each recovery retirement site.
				const f = intentCrashFixture(
					site === "restore" ? "publishing" : "launching",
				);
				fixtures.push(f);
				const baseline = fromPersisted(f.intent.before);
				const current =
					site === "restore"
						? fromPersisted(f.intent.staged)
						: site === "stale"
							? { ...baseline, cellularOverrideId: "surviving-grant" }
							: reduceOrchestrator(fromPersisted(f.intent.staged), {
									type: "OS_STAGING_ABORTED_FOR_STREAM",
									now: 789,
								});
				saveOrchestratorState(current, f.file);
				let fault = true;
				let retireCalls = 0;
				let syncCalls = 0;
				class Store extends OsAttemptIntentStore {
					override retire(
						intent: Parameters<OsAttemptIntentStore["retire"]>[0],
					): void {
						retireCalls++;
						if (fault && faultKind === "unlink") throw new Error("unlink IO");
						super.retire(intent);
					}
				}
				const store = new Store({
					...f.intentStore.storage,
					syncParent: (path) => {
						syncCalls++;
						if (fault) throw new Error("directory fsync IO");
						syncOrchestratorDirectory(path);
					},
				});
				const cadence = startupCadenceClock();
				const deps = {
					...f.deps,
					startupRetryClock: cadence.clock,
					osAttemptIntentStore: store,
					loadSettings: async () => ({
						...(await f.deps.loadSettings()),
						packagesAuto: false,
						systemAuto: false,
					}),
				};
				if (entry === "tick") {
					setOrchestratorRuntimeDepsForTest(deps);
					setOrchestratorStateForTest(current);
				}
				// When unlink or its acknowledgement fails in recovery, then retries.
				const recover =
					entry === "startup"
						? () => startUpdateOrchestrator(deps)
						: runOrchestratorTick;
				await expect(recover()).rejects.toThrow();
				expect(() => allowCellularOnce("third-snapshot")).toThrow(
					"retry shortly",
				);
				const retiredSnapshot = await loadOrchestratorState(f.file);
				const callsBeforeRetry = { retireCalls, syncCalls };
				await runOrchestratorTick();
				// Then one explicit pass spends at most one retirement/sync, never spins.
				expect(retireCalls - callsBeforeRetry.retireCalls).toBeLessThanOrEqual(
					1,
				);
				expect(syncCalls - callsBeforeRetry.syncCalls).toBeLessThanOrEqual(1);
				expect(() => allowCellularOnce("third-snapshot")).toThrow();
				expect(existsSync(f.intentStore.storage.path)).toBe(
					faultKind === "unlink",
				);
				const acknowledgedBeforeRepair = syncCalls;
				fault = false;
				await runOrchestratorTick();
				expect(syncCalls).toBeGreaterThan(acknowledgedBeforeRepair);
				if (entry === "startup") {
					const timer = cadence.timers[0];
					if (!timer) throw new Error("retirement must retain startup cadence");
					expect(timer.milliseconds).toBe(30_000);
					expect(timer.unreferenced).toBe(true);
					await timer.work();
					await startUpdateOrchestrator(deps);
				}
				allowCellularOnce("third-snapshot");
				expect(getOrchestratorState().cellularOverrideId).toBe(
					"third-snapshot",
				);
				expect(retiredSnapshot).toEqual(
					site === "restore" ? baseline : current,
				);
				const settled = getOrchestratorState();
				resetOrchestratorRuntimeForTest();
				await startUpdateOrchestrator(deps);
				expect(getOrchestratorState()).toEqual(settled);
			});
		}
	}
}
