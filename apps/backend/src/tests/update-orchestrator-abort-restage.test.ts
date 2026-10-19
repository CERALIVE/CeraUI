import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { quarantineDirs } from "./helpers/orchestrator-runtime-harness.ts";
import { harness } from "./helpers/orchestrator-runtime-os-scheduler.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
});

test("Install reports busy while the aborted producer recovers, then restages without Check", async () => {
	// Given a stage whose recovery continues after RAUC restart submission.
	const entered = Promise.withResolvers<void>();
	const retired = Promise.withResolvers<void>();
	let stages = 0;
	let live = false;
	let readinessReads = 0;
	harness([], {
		isOsStageReady: async () => {
			readinessReads++;
			return true;
		},
		isUpdateAdmissionReady: async () => true,
		isStreamLive: () => live,
		killAndRestartRaucForStream: async () => {},
		stageOs: async () => {
			stages++;
			if (stages === 1) {
				entered.resolve();
				await retired.promise;
				throw new OsStageError("os_stage_cancelled_for_stream");
			}
		},
	});
	const staging = runOrchestratorTick();
	await entered.promise;
	expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
	live = true;
	live = false; // operator Stop, while the cancelled producer still owns recovery
	const checks = getOrchestratorState().osCheck.lastSuccessAt;
	const priorReadinessReads = readinessReads;
	try {
		// When Install is pressed twice before the old producer retires.
		const first = await installUpdatesNow();
		const second = await installUpdatesNow();
		// Then this is a busy recovery, not an absent offer.
		expect([first, second]).toEqual([
			{ started: false, reason: "busy" },
			{ started: false, reason: "busy" },
		]);
		expect(stages).toBe(1);
		expect(readinessReads).toBe(priorReadinessReads);
	} finally {
		retired.resolve();
		await staging;
	}
	expect(await installUpdatesNow()).toEqual({ started: true });
	expect(stages).toBe(2);
	expect(getOrchestratorState().osCheck.lastSuccessAt).toBe(checks);
});

test("Install remains busy after producer retirement while RAUC restart is pending", async () => {
	// Given independent producer and restart lifetimes after a stream abort.
	const entered = Promise.withResolvers<void>();
	const retired = Promise.withResolvers<void>();
	const restartEntered = Promise.withResolvers<void>();
	const restartRelease = Promise.withResolvers<void>();
	let stages = 0;
	harness([], {
		isUpdateAdmissionReady: async () => true,
		killAndRestartRaucForStream: async () => {
			restartEntered.resolve();
			await restartRelease.promise;
		},
		stageOs: async () => {
			stages++;
			entered.resolve();
			await retired.promise;
			throw new OsStageError("os_stage_cancelled_for_stream");
		},
	});
	const staging = runOrchestratorTick();
	await entered.promise;
	const admission = admitAndPrepareStreamStart();
	await restartEntered.promise;
	retired.resolve();
	await staging;
	try {
		// When Install is pressed after producer retirement but before restart settles.
		const reply = await installUpdatesNow();
		// Then the remaining restart fence is busy, not an absent offer.
		expect(reply).toEqual({ started: false, reason: "busy" });
		expect(stages).toBe(1);
	} finally {
		restartRelease.resolve();
		await admission;
	}
});

test.each(["no-offer", "no-capability"] as const)(
	"Install returns not_available when there is %s rather than a stage blocker",
	async (kind) => {
		// Given genuine absence, not a retained producer or RAUC restart.
		const h = harness([], {
			isUpdateAdmissionReady: async () => true,
			...(kind === "no-offer"
				? {
						checkOsManifest: async () => ({
							available: false,
							rateLimited: false,
							failed: false,
							reason: "",
						}),
					}
				: {
						loadCapabilities: async () => ({
							mode: "capable",
							features: ["apt-all-packages"],
						}),
					}),
		});
		// When an operator asks to install.
		const reply = await installUpdatesNow();
		// Then busy must not substitute for not_available.
		expect(reply).toEqual({ started: false, reason: "not_available" });
		expect(h.calls.stages).toBe(0);
	},
);

test("Install returns busy when a stream starts during the final readiness await", async () => {
	// Given an available offer and an initially idle stream.
	let live = false;
	const h = harness([], {
		isUpdateAdmissionReady: async () => true,
		isStreamLive: () => live,
		isOsStageReady: async () => {
			live = true;
			return true;
		},
	});
	// When stream ownership changes while Install awaits readiness.
	const reply = await installUpdatesNow();
	// Then the second fence reports busy without staging.
	expect(reply).toEqual({ started: false, reason: "busy" });
	expect(h.calls.stages).toBe(0);
});

test("Install keeps not_available for a readiness refusal with no stage blocker", async () => {
	// Given no positive stage readiness but no stream or retained producer.
	const h = harness([], {
		isUpdateAdmissionReady: async () => true,
		isOsStageReady: async () => false,
	});
	// When Install reaches readiness.
	const reply = await installUpdatesNow();
	// Then only actual stage blockers are reclassified busy.
	expect(reply).toEqual({ started: false, reason: "not_available" });
	expect(h.calls.stages).toBe(0);
});
