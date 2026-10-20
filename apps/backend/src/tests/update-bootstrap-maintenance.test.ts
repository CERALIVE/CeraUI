import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { getLocalObservability } from "../modules/system/observability.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import { runUpdateBootstrap } from "../modules/system/update-bootstrap.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import * as persistence from "../modules/system/update-orchestrator/persistence.ts";
import {
	awaitUpdateStartupAdjudication,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

afterEach(resetBootReadiness);

for (const refusal of ["invalid-metadata", "safety"] as const) {
	test(`bootstrap marks health degraded and logs once when startup refuses ${refusal}`, async () => {
		// Given an untracked unit whose evidence must remain unconsumed.
		let unitObserved = false;
		let hourlyStarted = false;
		const log = spyOn(logger, "error").mockImplementation(() => logger);
		const f = runtimeFixture({
			acquireOsStageControl: async () => {
				throw new OsStageError("rauc_recovery_unproven");
			},
		});
		if (refusal === "invalid-metadata") {
			await Bun.write(
				f.file,
				JSON.stringify({
					...persistence.toPersisted(initialOrchestratorState(0)),
					osStageRecovery: { invalid: true },
				}),
			);
		} else {
			persistence.saveOrchestratorState(initialOrchestratorState(0), f.file);
		}
		try {
			// When the detached bootstrap receives the runtime's terminal adjudication.
			await runUpdateBootstrap({
				start: async () => {
					try {
						await startUpdateOrchestrator(f.deps);
					} catch (error) {
						if (!(error instanceof OsStageError)) throw error;
					}
					return awaitUpdateStartupAdjudication();
				},
				recover: async () => {
					unitObserved = true;
				},
				periodic: () => {
					hourlyStarted = true;
				},
			});
			// Then health names the maintenance gap without consuming the untracked unit.
			expect(getLocalObservability().readiness?.degradedSubsystems).toContain(
				"update-orchestrator-maintenance",
			);
			expect(log).toHaveBeenCalledTimes(1);
			expect(unitObserved).toBe(false);
			expect(hourlyStarted).toBe(false);
		} finally {
			f.cleanup();
			log.mockRestore();
		}
	});
}
