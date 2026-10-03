import { afterEach, expect, test } from "bun:test";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import {
	getUpdateState,
	recoverSoftwareUpdateIfRunning,
} from "../modules/system/software-updates.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { startUpdateOrchestrator } from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";
import {
	TestUpdateExit,
	updateHarness,
} from "./software-updates-preflight-harness.ts";

afterEach(resetBootReadiness);

for (const phase of ["committing", "downloading"] as const) {
	for (const finishedAtBoot of [true, false]) {
		test(`recovered ${phase} success persists before terminating when finishedAtBoot=${finishedAtBoot} and CONTROL is delayed`, async () => {
			// Given a tracked commit and a terminating exit seam, not a returning counter.
			await using h = await updateHarness();
			const events: string[] = [];
			const completion = Promise.withResolvers<number>();
			const boundary = Promise.withResolvers<"control" | "exit">();
			const release = Promise.withResolvers<void>();
			const exited = Promise.withResolvers<void>();
			const attached = Promise.withResolvers<void>();
			let hold = finishedAtBoot;
			let consumed = false;
			let probes = 0;
			h.restartExit = () => {
				events.push("exit");
				boundary.resolve("exit");
				exited.resolve();
				throw new TestUpdateExit();
			};
			const recover = () =>
				recoverSoftwareUpdateIfRunning({
					recover: async ({ onAttached }) => {
						probes++;
						if (consumed) return null;
						consumed = true;
						onAttached?.();
						attached.resolve();
						return {
							completion: completion.promise,
							wasAlreadyFinished: finishedAtBoot,
						};
					},
					scheduleRetry: () => {},
					resumePeriodicChecks: () => {},
				});
			const f = runtimeFixture({
				recoverSoftwareUpdateIfRunning: recover,
				getPackageInstallWireState: getUpdateState,
				acquireOsStageControl: async () => {
					if (hold) {
						boundary.resolve("control");
						await release.promise;
					}
					return acquireTestOsStageControl();
				},
				persist: (state) => {
					saveOrchestratorState(state, f.file);
					events.push(`durable:${state.phase}`);
				},
			});
			saveOrchestratorState({ ...initialOrchestratorState(0), phase }, f.file);
			const startup = startUpdateOrchestrator(f.deps);
			try {
				await attached.promise;
				const joined = recover();
				// When an already finished unit drains, or the attached running unit later finishes.
				if (!finishedAtBoot) {
					await startup;
					events.length = 0;
					hold = true;
				}
				completion.resolve(0);
				expect(await boundary.promise).toBe("control");
				expect(h.restarts).toBe(0);
				expect((await loadOrchestratorState(f.file))?.phase).toBe(phase);
				release.resolve();
				await startup;
				await exited.promise;
				await joined;
				// Then actual termination follows the durable transition without needing a scheduler tick.
				expect(events.indexOf("durable:restarting-services")).toBeGreaterThan(
					-1,
				);
				expect(events.indexOf("durable:restarting-services")).toBeLessThan(
					events.indexOf("exit"),
				);
				if (phase === "committing")
					expect(events).toEqual(["durable:restarting-services", "exit"]);
				expect((await loadOrchestratorState(f.file))?.phase).toBe(
					"restarting-services",
				);
				expect(probes).toBe(1);
			} finally {
				release.resolve();
				await startup;
				f.cleanup();
			}
		});
	}
}

test("recovered success keeps the backend alive when its authoritative tail cannot persist", async () => {
	// Given success whose startup persistence fails for the entire burst.
	await using h = await updateHarness();
	let writes = 0;
	const f = runtimeFixture({
		recoverSoftwareUpdateIfRunning: () =>
			recoverSoftwareUpdateIfRunning({
				recover: async ({ onAttached }) => {
					onAttached?.();
					return { completion: Promise.resolve(0), wasAlreadyFinished: true };
				},
				scheduleRetry: () => {},
				resumePeriodicChecks: () => {},
			}),
		getPackageInstallWireState: getUpdateState,
		persist: () => {
			writes++;
			throw new Error("fixture storage offline");
		},
	});
	saveOrchestratorState(
		{ ...initialOrchestratorState(0), phase: "committing" },
		f.file,
	);
	try {
		// When startup exhausts its finite retry budget.
		await expect(startUpdateOrchestrator(f.deps)).rejects.toThrow(
			"storage offline",
		);
		// Then no deliberate exit discards the only observed success.
		expect(writes).toBe(6);
		expect(h.restarts).toBe(0);
		expect((await loadOrchestratorState(f.file))?.phase).toBe("committing");
		expect(getUpdateState().kind).toBe("success");
	} finally {
		f.cleanup();
	}
});
