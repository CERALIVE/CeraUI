import { afterEach, expect, spyOn, test } from "bun:test";
import { guardNonCritical } from "../helpers/boot-guard.ts";
import { runUpdateBootstrap } from "../modules/system/update-bootstrap.ts";
import * as persistence from "../modules/system/update-orchestrator/persistence.ts";
import {
	awaitUpdateStartupAdjudication,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";
import { startupCadenceClock } from "./helpers/startup-cadence-clock.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("transient burst exhaustion keeps standalone recovery parked until later startup adjudication", async () => {
	// Given a committing plan whose first state read keeps failing transiently.
	const c = startupCadenceClock();
	const effects: string[] = [];
	const f = runtimeFixture({
		startupRetryClock: c.clock,
		recoverSoftwareUpdateIfRunning: async () => {
			effects.push("orchestrator-recovery");
			return true;
		},
		getPackageInstallWireState: () => ({ kind: "success" }),
	});
	fixtures.push(f);
	persistence.saveOrchestratorState(
		{ ...initialOrchestratorState(0), phase: "committing" },
		f.file,
	);
	let faulty = true;
	const read = persistence.loadOrchestratorState;
	const reader = spyOn(persistence, "loadOrchestratorState").mockImplementation(
		async (...args) => {
			if (faulty) throw new Error("transient read failure");
			return read(...args);
		},
	);
	const burstDone = Promise.withResolvers<void>();
	try {
		// When the detached chain observes burst failure but not an adjudicated plan.
		const completion = runUpdateBootstrap({
			start: async () => {
				await guardNonCritical("update-orchestrator", () =>
					startUpdateOrchestrator(f.deps),
				);
				burstDone.resolve();
				return awaitUpdateStartupAdjudication();
			},
			recover: async () => {
				effects.push("standalone");
			},
			periodic: () => {
				effects.push("periodic");
			},
		});
		await burstDone.promise;
		expect(effects).toEqual([]);
		const timer = c.timers[0];
		if (!timer) throw new Error("background retry was not armed");
		faulty = false;
		await timer.work();
		await completion;
		// Then eventual startup owns recovery first, followed by the reserved chain.
		expect(effects).toEqual([
			"orchestrator-recovery",
			"standalone",
			"periodic",
		]);
		expect((await read(f.file))?.phase).toBe("restarting-services");
		expect(c.timers).toHaveLength(1);
	} finally {
		reader.mockRestore();
	}
});
