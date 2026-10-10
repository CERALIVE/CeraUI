import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	prepareOsStageJob,
	readOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { fromPersisted } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { intentCrashFixture } from "./helpers/os-attempt-intent-fixture.ts";
import { streamRpcFixture } from "./helpers/os-attempt-intent-stream-rpc.ts";
import { lifecycleFixture } from "./helpers/os-attempt-lifecycle-fixture.ts";
import { record } from "./helpers/os-stage-startup-harness.ts";

const fixtures: ReturnType<typeof intentCrashFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const evidence of ["unlaunched", "different-attempt"] as const) {
	test(`D8 refuses readable ${evidence} job without inferring cancellation authority`, async () => {
		// Given valid but insufficient job evidence beside publishing authority.
		const f = intentCrashFixture();
		fixtures.push(f);
		const jobDir = join(dirname(f.file), "stage-job");
		await prepareOsStageJob(
			{
				...record,
				attemptId:
					evidence === "unlaunched" ? f.intent.attemptId : record.attemptId,
				launched: evidence !== "unlaunched",
			},
			jobDir,
			f.witnessDeps.uid,
		);
		let kills = 0;
		setOrchestratorRuntimeDepsForTest({
			...f.deps,
			readOsStageJob: () => readOsStageJob(jobDir, f.witnessDeps.uid),
			killAndRestartRaucForStream: async () => {
				kills++;
			},
		});
		setOrchestratorStateForTest(fromPersisted(f.intent.staged));
		const bytes = [
			f.file,
			f.intentStore.storage.path,
			join(jobDir, "job.json"),
		].map((path) => ({ path, value: readFileSync(path) }));
		await using rpc = await streamRpcFixture();
		// When D8 probes the fallback through the actual session/adapter path.
		const reply = await rpc.request();
		// Then positive launch AND matching identity remain required.
		expect(reply.error).toEqual({
			code: "UPDATE_ORCHESTRATOR_INITIALIZING",
			retryable: true,
		});
		for (const { path, value } of bytes)
			expect(readFileSync(path)).toEqual(value);
		expect(kills).toBe(0);
		expect(rpc.launches()).toBe(0);
	});
}

test("D8 still cancels a live matching launched producer despite publishing evidence", async () => {
	// Given a real launched job and producer held until its abort signal.
	const f = lifecycleFixture();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let kills = 0;
	let aborted = false;
	await f.offer({
		killAndRestartRaucForStream: async () => {
			kills++;
		},
		stageOs: async (_candidate, _progress, control) => {
			if (!control?.signal) throw new Error("stage signal missing");
			control.signal.addEventListener(
				"abort",
				() => {
					aborted = true;
					finish.resolve();
				},
				{ once: true },
			);
			entered.resolve();
			await finish.promise;
			throw new OsStageError("os_stage_cancelled_for_stream");
		},
	});
	const install = installUpdatesNow();
	try {
		await entered.promise;
		const launching = f.intentStore.read();
		if (!launching) throw new Error("launched intent missing");
		f.intentStore.write({ ...launching, phase: "publishing" }, launching);
		await using rpc = await streamRpcFixture();
		// When the positive fallback permits today's D8 producer abort.
		const reply = await rpc.request();
		// Then the original signal/RAUC/zero-round cancellation behavior is intact.
		expect(reply.error).toBeUndefined();
		expect(reply.result?.result).toBe("started");
		expect(aborted).toBe(true);
		expect(kills).toBe(1);
		expect(rpc.launches()).toBe(1);
		await install;
		expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(0);
	} finally {
		finish.resolve();
		await install;
		f.cleanup();
	}
});
