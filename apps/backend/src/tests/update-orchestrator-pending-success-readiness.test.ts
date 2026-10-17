import { afterEach, expect, test } from "bun:test";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import * as updates from "../modules/system/software-updates.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	allowCellularOnce,
	checkUpdatesNow,
	installUpdatesNow,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { UpdateStartupReadiness } from "../modules/system/update-orchestrator/startup-readiness.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";
import {
	TestUpdateExit,
	updateHarness,
} from "./software-updates-preflight-harness.ts";

afterEach(resetBootReadiness);

test("manual mutations stay initializing when a running recovery completes during startup tail CONTROL", async () => {
	// Given startup attached a running package unit and is waiting for its tail lease.
	await using h = await updateHarness();
	const completion = Promise.withResolvers<number>();
	const tail = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const owner = Promise.withResolvers<void>();
	const acknowledge = Promise.withResolvers<void>();
	let acquisitions = 0;
	h.restartExit = () => {
		throw new TestUpdateExit();
	};
	const f = runtimeFixture({
		recoverSoftwareUpdateIfRunning: () =>
			updates.recoverSoftwareUpdateIfRunning({
				recover: async ({ onAttached }) => {
					onAttached?.();
					return { completion: completion.promise, wasAlreadyFinished: false };
				},
				scheduleRetry: () => {},
				resumePeriodicChecks: () => {},
			}),
		getPackageInstallWireState: updates.getUpdateState,
		acquireOsStageControl: async () => {
			acquisitions++;
			if (acquisitions === 1) {
				tail.resolve();
				await release.promise;
			} else if (acquisitions === 2) {
				owner.resolve();
				await acknowledge.promise;
			}
			return acquireTestOsStageControl();
		},
	});
	saveOrchestratorState(
		{ ...initialOrchestratorState(0), phase: "committing" },
		f.file,
	);
	const startup = startUpdateOrchestrator(f.deps);
	try {
		await tail.promise;
		// When completion arrives before the tail that normally opens readiness.
		completion.resolve(0);
		await h.settled();
		release.resolve();
		await startup;
		await owner.promise;
		// Then all manual mutations independently include the package durability predicate.
		expect(() => allowCellularOnce("pending")).toThrow("initializing");
		await expect(checkUpdatesNow()).rejects.toThrow("initializing");
		await expect(installUpdatesNow()).rejects.toThrow("initializing");
		acknowledge.resolve();
		await h.restarted();
		expect(() => allowCellularOnce("durable")).not.toThrow();
		expect(await checkUpdatesNow()).toEqual({ started: false, reason: "busy" });
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "busy",
		});
	} finally {
		release.resolve();
		acknowledge.resolve();
		await startup;
		await h.restarted();
		f.cleanup();
	}
});

test("package acknowledgement cannot authorize unfinished startup or override another durability closure", () => {
	// Given startup validity and two independent durability predicates.
	let packagePending = true;
	const readiness = new UpdateStartupReadiness(() => !packagePending);
	// When package acknowledgement removes only its own closure.
	packagePending = false;
	// Then startup still refuses, and an OS closure still refuses after valid startup.
	expect(() => readiness.assertReady()).toThrow("initializing");
	readiness.setReady(true);
	expect(() => readiness.assertReady(false)).toThrow("initializing");
	packagePending = true;
	expect(() => readiness.assertReady(true)).toThrow("initializing");
	packagePending = false;
	expect(() => readiness.assertReady(true)).not.toThrow();
});
