import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

afterEach(() => {
	pendingPackageSuccess.resetForTest();
	resetBootReadiness();
});

test("a repeated no-op completion cannot clear failed success persistence from memory alone", async () => {
	// Given memory ahead of disk after the callback's write failed.
	const f = runtimeFixture();
	const baseline = {
		...initialOrchestratorState(0),
		phase: "committing" as const,
	};
	const success = reduceOrchestrator(baseline, {
		type: "COMMIT_SUCCEEDED",
		now: 10,
	});
	pendingPackageSuccess.configure(
		{
			snapshot: () => success,
			pending: () => false,
			acquireControl: acquireTestOsStageControl,
			readPersisted: () => loadOrchestratorState(f.file),
			persist: f.deps.persist,
		},
		() => {},
		() => 10,
	);
	saveOrchestratorState(baseline, f.file);
	pendingPackageSuccess.retain(baseline, success);
	try {
		// When another callback returns without a durable write.
		await expect(pendingPackageSuccess.invoke(() => {})).rejects.toThrow(
			"durable acknowledgement",
		);
		// Then its phase alone grants neither scheduler permission nor restart.
		expect(pendingPackageSuccess.pending).toBe(true);
		expect((await loadOrchestratorState(f.file))?.phase).toBe("committing");
	} finally {
		f.cleanup();
	}
});

test("success retry refuses authoritative disk drift and retains its fence", async () => {
	// Given an observed completion whose baseline was replaced on disk.
	const f = runtimeFixture();
	const baseline = {
		...initialOrchestratorState(0),
		phase: "committing" as const,
	};
	let memory: OrchestratorState = baseline;
	let writes = 0;
	pendingPackageSuccess.configure(
		{
			snapshot: () => memory,
			pending: () => false,
			acquireControl: acquireTestOsStageControl,
			readPersisted: () => loadOrchestratorState(f.file),
			persist: () => {
				writes++;
			},
		},
		(state) => {
			memory = state;
		},
		() => 10,
	);
	pendingPackageSuccess.observe();
	saveOrchestratorState(initialOrchestratorState(100), f.file);
	const log = spyOn(logger, "error").mockImplementation(() => logger);
	try {
		// When the tick retries that exact success.
		await pendingPackageSuccess.retry();
		// Then no replacement record is overwritten and maintenance stays fenced.
		expect(writes).toBe(0);
		expect(pendingPackageSuccess.pending).toBe(true);
		expect(log).toHaveBeenCalledTimes(1);
	} finally {
		log.mockRestore();
		f.cleanup();
	}
});

test("reset clears pending success and cancels a replay already awaiting CONTROL", async () => {
	// Given a pending successful completion parked behind another CONTROL owner.
	const f = runtimeFixture();
	const baseline = {
		...initialOrchestratorState(0),
		phase: "committing" as const,
	};
	const acquired = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let reads = 0;
	let writes = 0;
	pendingPackageSuccess.configure(
		{
			snapshot: () => baseline,
			pending: () => false,
			acquireControl: async () => {
				acquired.resolve();
				await release.promise;
				return acquireTestOsStageControl();
			},
			readPersisted: async () => {
				reads++;
				return baseline;
			},
			persist: () => {
				writes++;
			},
		},
		() => {
			writes++;
		},
		() => 10,
	);
	pendingPackageSuccess.observe();
	const replay = pendingPackageSuccess.retry();
	await acquired.promise;
	try {
		// When runtime teardown clears the fence before the late lease arrives.
		f.cleanup();
		release.resolve();
		await replay;
		// Then cancelled work cannot read/write/adopt into the next runtime.
		expect(pendingPackageSuccess.pending).toBe(false);
		expect(reads).toBe(0);
		expect(writes).toBe(0);
	} finally {
		release.resolve();
	}
});
