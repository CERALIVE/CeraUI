import { afterEach, expect, spyOn, test } from "bun:test";
import { proveRuntimeOsWriterQuiescent } from "../modules/system/update-orchestrator/os-runtime-control.ts";
import * as jobFiles from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import * as startup from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("witness evidence receives the held control lease", async () => {
	// Given a witness whose quiescence proof requires the runtime's lease.
	const f = runtimeFixture({
		proveOsWriterQuiescent: async (lease) => lease?.held() === true,
	});
	fixtures.push(f);
	saveOrchestratorState(identifiedState(), f.file);
	f.writeWitness();
	// When startup requests settlement evidence.
	await startUpdateOrchestrator(f.deps);
	// Then the leased proof can settle once instead of leaving unsafe state.
	expect(getOrchestratorState().osStageRecovery?.mode).toBe("operator");
	expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(1);
});

test("nested guard reconciliation borrows rather than reacquires the evidence lease", async () => {
	// Given a live owner lease and a validated job requiring guard reconciliation.
	await using lease = await acquireTestOsStageControl();
	const read = spyOn(jobFiles, "readOsStageJob").mockResolvedValue({
		schema: 1,
		attemptId: input.attemptId,
		candidateKey: input.manifestJson,
		bundleUrl: manifest.bundle.url,
		baseline: {
			instance: "1:1",
			active: true,
			operation: "idle",
			processes: ["1:1"],
			resources: [],
			bootId: input.bootId,
			bootPrimary: "A",
			bootedSlot: "A",
			bootedDevice: "/dev/a",
			bootedHealthy: true,
			targetSlot: "B",
			targetDevice: "/dev/b",
			targetInactive: true,
			activationArmed: false,
		},
		processes: [],
		resources: [],
		launched: false,
		cliSettled: true,
		requireNewInstance: false,
	});
	let borrowed = false;
	const reconcile = spyOn(
		startup,
		"reconcileOsStageStartup",
	).mockImplementation(async (overrides) => {
		if (!overrides?.acquireControl)
			throw new Error("borrowed acquisition missing");
		await using control = await overrides.acquireControl();
		borrowed = control.held();
		return { kind: "none" };
	});
	const ready = spyOn(startup, "isOsStageReady").mockResolvedValue(true);
	try {
		// When production quiescence proof encounters that job under CONTROL.
		expect(await proveRuntimeOsWriterQuiescent(lease)).toBe(true);
		// Then nested disposal leaves the original lock held for authoritative persistence.
		expect(borrowed).toBe(true);
		expect(lease.held()).toBe(true);
	} finally {
		ready.mockRestore();
		reconcile.mockRestore();
		read.mockRestore();
	}
});
