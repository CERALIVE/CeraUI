import { afterEach, expect, test } from "bun:test";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import { finishSoftwareUpdateRestart } from "../modules/system/software-update-restart.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { getRecoveredUpdateExitHook } from "../modules/system/update-orchestrator/recovery-exit-gate.ts";
import {
	resetOrchestratorRuntimeForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";
import { TestUpdateExit } from "./software-update-exit-harness.ts";

afterEach(resetBootReadiness);

test("reset cancels an adjudicated recovered exit while CONTROL is held and retires its late lease", async () => {
	// Given an initialized tracked owner and an exit hook already past adjudication.
	const acquired = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const disposed = Promise.withResolvers<void>();
	let hold = false;
	let reads = 0;
	let writes = 0;
	let exits = 0;
	const f = runtimeFixture({
		recoverSoftwareUpdateIfRunning: async () => true,
		getPackageInstallWireState: () => ({
			kind: "downloading",
			progress: { total: 1, downloading: 0, unpacking: 0, setting_up: 0 },
		}),
		readPersistedState: async () => {
			reads++;
			return loadOrchestratorState(f.file);
		},
		persist: (state) => {
			writes++;
			saveOrchestratorState(state, f.file);
		},
		acquireOsStageControl: async () => {
			if (!hold) return acquireTestOsStageControl();
			acquired.resolve();
			await release.promise;
			return {
				held: () => true,
				async [Symbol.asyncDispose]() {
					disposed.resolve();
				},
			};
		},
	});
	saveOrchestratorState(
		{ ...initialOrchestratorState(0), phase: "committing" },
		f.file,
	);
	try {
		await startUpdateOrchestrator(f.deps);
		hold = true;
		const hook = getRecoveredUpdateExitHook();
		expect(hook).toBeDefined();
		const tail = finishSoftwareUpdateRestart(hook, () => {
			exits++;
			throw new TestUpdateExit();
		});
		await acquired.promise;
		reads = 0;
		writes = 0;
		// When reset cancels that authority, without waiting for foreign CONTROL.
		resetOrchestratorRuntimeForTest();
		release.resolve();
		await tail;
		await disposed.promise;
		// Then the late lease is disposed without reading, persisting or terminating.
		expect(reads).toBe(0);
		expect(writes).toBe(0);
		expect(exits).toBe(0);
		expect((await loadOrchestratorState(f.file))?.phase).toBe("committing");
	} finally {
		release.resolve();
		f.cleanup();
	}
});
