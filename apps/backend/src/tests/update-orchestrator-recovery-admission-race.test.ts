import { afterEach, expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { withMemoryPersistence } from "./helpers/orchestrator-memory-persistence.ts";
import {
	capabilities,
	cleanupRecovery,
	deferred,
	RETRY_DELAY,
	recoveryHarness,
	settings,
	T0,
} from "./helpers/os-recovery-harness.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

afterEach(cleanupRecovery);

test.each(["os_transport_failed", "rauc_install_failed"] as const)(
	"C-R1 rejects an automatic preflight when manual settlement changes policy to %s",
	async (reason) => {
		// Given a discovered candidate; only the old automatic capability read parks.
		const parked = deferred<void>();
		const release = deferred<void>();
		const h = await recoveryHarness({
			stageOs: async () => {
				throw new OsStageError(reason);
			},
		});
		let reads = 0;
		setOrchestratorRuntimeDepsForTest(
			withMemoryPersistence({
				acquireOsStageControl: acquireTestOsStageControl,
				loadCapabilities: async () => {
					if (++reads === 1) {
						parked.resolve();
						await release.promise;
					}
					return capabilities;
				},
				loadSettings: async () => settings,
				now: () => h.clock.now,
				onlyMeteredCandidateExists: async () => false,
				isIdle: async () => true,
				isStreamLive: () => false,
				persist: () => undefined,
				stageOs: async () => {
					h.calls.stages++;
					throw new OsStageError(reason);
				},
			}),
		);
		// When manual Install settles before the earlier automatic preflight resumes.
		const tick = runOrchestratorTick();
		await parked.promise;
		await installUpdatesNow();
		release.resolve();
		await tick;
		// Then the old tick cannot spend the new deadline or bypass the new pause.
		expect(h.calls.stages).toBe(1);
		expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(1);
		expect(getOrchestratorState().osStageRecovery?.nextRetryAt).toBe(
			reason === "os_transport_failed" ? T0 + RETRY_DELAY : null,
		);
	},
);
