import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import * as restart from "../modules/system/software-update-restart.ts";
import * as updates from "../modules/system/software-updates.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	allowCellularOnce,
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { reconcileStaleUnits } from "../modules/system/update-orchestrator/stale-services.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";
import {
	TestUpdateExit,
	updateHarness,
} from "./software-updates-preflight-harness.ts";

afterEach(resetBootReadiness);

for (const recovered of [false, true]) {
	test(`pending package success fences stale backend restart and retries durable success when recovered=${recovered}`, async () => {
		// Given an idle device whose backend maps an upgraded, deleted system library.
		await using h = await updateHarness();
		const proc = await mkdtemp(join(tmpdir(), "pending-success-proc-"));
		await mkdir(join(proc, "123"));
		await Bun.write(
			join(proc, "123/maps"),
			"0000-1000 r-xp 0000 00:00 0 /usr/lib/old.so (deleted)\n",
		);
		await Bun.write(
			join(proc, "123/cgroup"),
			"0::/system.slice/ceralive.service\n",
		);
		const completion = Promise.withResolvers<number>();
		const observed = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<void>();
		const events: string[] = [];
		h.restartExit = () => {
			events.push("exit");
			exited.resolve();
			throw new TestUpdateExit();
		};
		let failWrites = false;
		let completed = false;
		let attempts = 0;
		let reconciles = 0;
		let restarts = 0;
		const log = spyOn(logger, "error").mockImplementation(() => {
			observed.resolve();
			return logger;
		});
		const f = runtimeFixture({
			recoverSoftwareUpdateIfRunning: recovered
				? () =>
						updates.recoverSoftwareUpdateIfRunning({
							recover: async ({ onAttached }) => {
								onAttached?.();
								return {
									completion: completion.promise,
									wasAlreadyFinished: false,
								};
							},
							scheduleRetry: () => {},
							resumePeriodicChecks: () => {},
						})
				: async () => true,
			getPackageInstallWireState: recovered
				? updates.getUpdateState
				: () =>
						completed
							? { kind: "success" }
							: {
									kind: "downloading",
									progress: {
										total: 1,
										downloading: 0,
										unpacking: 0,
										setting_up: 0,
									},
								},
			persist: (state) => {
				attempts++;
				if (failWrites) throw new Error("fixture storage offline");
				saveOrchestratorState(state, f.file);
				events.push(`durable:${state.phase}`);
			},
			restartStale: async (isIdle, transactionRunning) => {
				reconciles++;
				return reconcileStaleUnits({
					procRoot: proc,
					isIdle,
					transactionRunning,
					restart: async () => {
						restarts++;
						events.push("restart");
					},
					recommend: () => {},
				});
			},
		});
		saveOrchestratorState(
			{ ...initialOrchestratorState(0), phase: "committing" },
			f.file,
		);
		const launch = spyOn(updates, "startSoftwareUpdate").mockImplementation(
			(hook) => {
				void restart.finishSoftwareUpdateRestart(hook, () => {
					events.push("exit");
					exited.resolve();
					throw new TestUpdateExit();
				});
				return { started: true };
			},
		);
		try {
			await startUpdateOrchestrator(f.deps);
			attempts = 0;
			events.length = 0;
			failWrites = true;
			completed = true;
			// When observed success cannot be persisted by its fresh callback or recovered hook.
			if (recovered) completion.resolve(0);
			else defaultOrchestratorRuntimeDeps.startPackageInstall();
			await observed.promise;
			expect(getBootReadiness().degradedSubsystems).toContain(
				"update-orchestrator-maintenance",
			);
			expect((await loadOrchestratorState(f.file))?.phase).toBe("committing");
			const beforeTick = attempts;
			expect(() => allowCellularOnce("replacement")).toThrow("initializing");
			await runOrchestratorTick();
			await runOrchestratorTick();
			// Then every tick retries success, never reconciliation or evidence retirement.
			expect(attempts).toBe(beforeTick + 2);
			expect(reconciles).toBe(0);
			expect(restarts).toBe(0);
			expect(h.restarts).toBe(0);
			failWrites = false;
			const durableTick = runOrchestratorTick();
			expect(
				await Promise.race([
					exited.promise.then(() => true),
					durableTick.then(() => false),
				]),
			).toBe(true);
			await durableTick;
			expect((await loadOrchestratorState(f.file))?.phase).toBe(
				"restarting-services",
			);
			expect(getOrchestratorState().phase).toBe("restarting-services");
			expect(reconciles).toBe(0);
			expect(events.indexOf("durable:restarting-services")).toBeLessThan(
				events.indexOf("exit"),
			);
			expect(() => allowCellularOnce("durable")).not.toThrow();
			await runOrchestratorTick();
			expect(restarts).toBe(1);
			expect(events.indexOf("durable:restarting-services")).toBeLessThan(
				events.indexOf("restart"),
			);
		} finally {
			f.cleanup();
			launch.mockRestore();
			log.mockRestore();
			await rm(proc, { recursive: true });
		}
	});
}
