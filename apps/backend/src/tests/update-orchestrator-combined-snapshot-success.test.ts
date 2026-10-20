import { afterEach, expect, spyOn, test } from "bun:test";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import * as updates from "../modules/system/software-updates.ts";
import * as directorySync from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	allowCellularOnce,
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";
import {
	TestUpdateExit,
	updateHarness,
} from "./software-updates-preflight-harness.ts";

afterEach(resetBootReadiness);

for (const first of ["package", "snapshot"] as const) {
	test(`${first}-first real startup failure lets both durability owners progress without granting startup permission`, async () => {
		// Given a real tracked unit, disk snapshot and an unacknowledged tail rename.
		await using h = await updateHarness();
		const completion = Promise.withResolvers<number>();
		const waiting = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const effects: string[] = [];
		let fault = true;
		let syncs = 0;
		let staleRestarts = 0;
		const synchronize = directorySync.syncOrchestratorDirectory;
		const sync = spyOn(
			directorySync,
			"syncOrchestratorDirectory",
		).mockImplementation((path) => {
			syncs++;
			if (fault) throw new Error("combined tail directory sync unavailable");
			synchronize(path);
		});
		h.restartExit = () => {
			effects.push("exit");
			throw new TestUpdateExit();
		};
		const f = runtimeFixture({
			startupRetryClock: {
				wait: async () => {
					waiting.resolve();
					await resume.promise;
				},
			},
			recoverSoftwareUpdateIfRunning: () =>
				updates.recoverSoftwareUpdateIfRunning({
					recover: async ({ onAttached }) => {
						onAttached?.();
						return {
							completion: completion.promise,
							wasAlreadyFinished: first === "package",
						};
					},
					scheduleRetry: () => {},
					resumePeriodicChecks: () => {},
				}),
			getPackageInstallWireState: updates.getUpdateState,
			persist: (state) => {
				saveOrchestratorState(state, f.file);
				effects.push(`durable:${state.phase}`);
			},
			restartStale: async () => {
				staleRestarts++;
				return true;
			},
		});
		// The initial baseline must be durable before the production fault is armed.
		fault = false;
		saveOrchestratorState(
			{ ...initialOrchestratorState(0), phase: "committing" },
			f.file,
		);
		fault = true;
		if (first === "package") completion.resolve(0);
		const startup = startUpdateOrchestrator(f.deps);
		try {
			await waiting.promise;
			if (first === "snapshot") completion.resolve(0);
			await h.settled();
			expect(pendingPackageSuccess.pending).toBe(true);
			expect(h.restarts).toBe(0);
			const renamed = await loadOrchestratorState(f.file);
			expect(renamed?.phase).toBe(
				first === "package" ? "restarting-services" : "committing",
			);
			expect(renamed).toEqual(getOrchestratorState());
			const attempts = syncs;
			// When storage heals, an ordinary tick must service the snapshot owner first.
			fault = false;
			await runOrchestratorTick();
			// Then a real acknowledged replay occurs, but unfinished startup still refuses.
			expect(syncs).toBeGreaterThan(attempts);
			expect(staleRestarts).toBe(0);
			expect(h.restarts).toBe(0);
			expect(() => allowCellularOnce("still-starting")).toThrow("initializing");
			await expect(checkUpdatesNow()).rejects.toThrow("initializing");
			await expect(installUpdatesNow()).rejects.toThrow("initializing");
			expect(pendingPackageSuccess.pending).toBe(true);
			expect(await loadOrchestratorState(f.file)).toEqual(renamed);
			resume.resolve();
			await startup;
			await h.restarted();
			expect((await loadOrchestratorState(f.file))?.phase).toBe(
				"restarting-services",
			);
			expect(pendingPackageSuccess.pending).toBe(false);
			expect(effects.indexOf("durable:restarting-services")).toBeLessThan(
				effects.indexOf("exit"),
			);
			expect(h.restarts).toBe(1);
			expect(() => allowCellularOnce("durable")).not.toThrow();
		} finally {
			fault = false;
			resume.resolve();
			completion.resolve(0);
			await startup;
			await h.restarted();
			sync.mockRestore();
			f.cleanup();
		}
	});
}
