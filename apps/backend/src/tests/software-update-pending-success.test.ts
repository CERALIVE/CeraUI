import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import * as updates from "../modules/system/software-updates.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { startUpdateOrchestrator } from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

afterEach(resetBootReadiness);

test("legacy scheduled discovery, Check, Install and recovery cannot erase pending observed success", async () => {
	// Given real recovered success whose disk write remains unavailable.
	await using h = await updateHarness();
	const recover = () =>
		updates.recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached }) => {
				onAttached?.();
				return { completion: Promise.resolve(0), wasAlreadyFinished: true };
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
	const f = runtimeFixture({
		recoverSoftwareUpdateIfRunning: recover,
		getPackageInstallWireState: updates.getUpdateState,
		persist: () => {
			throw new Error("fixture disk unavailable");
		},
	});
	saveOrchestratorState(
		{ ...initialOrchestratorState(0), phase: "committing" },
		f.file,
	);
	const log = spyOn(logger, "error").mockImplementation(() => logger);
	let checks = 0;
	updates.setSoftwareUpdateCheckRunner(() => {
		checks++;
		return true;
	});
	try {
		await expect(startUpdateOrchestrator(f.deps)).rejects.toThrow(
			"disk unavailable",
		);
		expect(updates.getUpdateState().kind).toBe("success");
		// When independent legacy callers arrive during the pending durability window.
		updates.periodicCheckForSoftwareUpdates();
		expect(updates.triggerManualUpdateCheck()).toBe(false);
		expect(updates.startSoftwareUpdate()).toEqual({
			started: false,
			reason: "check_unavailable",
		});
		expect(await updates.runUpdateDiscoveryAndReport()).toBe(
			"discovery_failed",
		);
		let probes = 0;
		await updates.recoverSoftwareUpdateIfRunning({
			recover: async () => {
				probes++;
				return null;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
		// Then wire success and disk evidence survive with no new launch or unit probe.
		expect(checks).toBe(0);
		expect(probes).toBe(0);
		expect(h.launches).toHaveLength(0);
		expect(updates.getUpdateState().kind).toBe("success");
		expect((await loadOrchestratorState(f.file))?.phase).toBe("committing");
	} finally {
		f.cleanup();
		log.mockRestore();
	}
});
