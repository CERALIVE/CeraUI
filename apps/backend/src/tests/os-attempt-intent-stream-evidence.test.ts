import { afterEach, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ORPCError } from "@orpc/server";
import { logger } from "../helpers/logger.ts";
import { SpawnTimeoutError } from "../helpers/spawn-policy.ts";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import {
	prepareOsStageJob,
	readOsStageJob,
	retireOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { fromPersisted } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { intentCrashFixture } from "./helpers/os-attempt-intent-fixture.ts";
import { streamRpcFixture } from "./helpers/os-attempt-intent-stream-rpc.ts";
import { record } from "./helpers/os-stage-startup-harness.ts";

const fixtures: ReturnType<typeof intentCrashFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const fault of [
	"corrupt-intent",
	"wrong-owner-intent",
	"wrong-mode-intent",
	"oversized-intent",
	"unreadable-intent",
	"corrupt-job",
	"invalid-job",
	"unreadable-job",
	"guardian-observation",
] as const) {
	test(`D8 preserves authority and retries through the adapter when ${fault}`, async () => {
		// Given real crash authority and a failed read, not an absent producer.
		const f = intentCrashFixture();
		fixtures.push(f);
		const intentPath = f.intentStore.storage.path;
		const jobDir = join(dirname(f.file), "stage-job");
		const jobPath = join(jobDir, "job.json");
		const held = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<void>();
		let repaired = false;
		let kills = 0;
		let observations = 0;
		let jobBytes: Buffer<ArrayBuffer> | undefined;
		let store = f.intentStore;
		switch (fault) {
			case "corrupt-intent":
				writeFileSync(intentPath, "{");
				break;
			case "wrong-owner-intent":
				store = new OsAttemptIntentStore({
					...store.storage,
					uid: store.storage.uid + 1,
				});
				break;
			case "wrong-mode-intent":
				chmodSync(intentPath, 0o644);
				break;
			case "oversized-intent":
				writeFileSync(intentPath, "x".repeat(65_537));
				break;
			case "unreadable-intent": {
				const target = join(dirname(f.file), "intent-target");
				writeFileSync(target, JSON.stringify(f.intent), { mode: 0o600 });
				unlinkSync(intentPath);
				symlinkSync(target, intentPath);
				break;
			}
			case "corrupt-job":
			case "invalid-job":
			case "unreadable-job":
				await prepareOsStageJob(record, jobDir, f.witnessDeps.uid);
				if (fault === "unreadable-job") {
					unlinkSync(jobPath);
					symlinkSync(join(jobDir, "token"), jobPath);
				} else {
					writeFileSync(jobPath, fault === "corrupt-job" ? "{" : "{}");
				}
				jobBytes = readFileSync(jobPath);
				break;
			case "guardian-observation":
				break;
			default: {
				const unreachable: never = fault;
				throw unreachable;
			}
		}
		const deps = {
			...f.deps,
			osAttemptIntentStore: store,
			readOsStageJob: () => readOsStageJob(jobDir, f.witnessDeps.uid),
			osStageStartupDeps: {
				run: async () => {
					observations++;
					if (fault === "guardian-observation" && !repaired) {
						observed.resolve();
						await held.promise;
						throw new SpawnTimeoutError("systemctl show");
					}
					return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
				},
			},
			killAndRestartRaucForStream: async () => {
				kills++;
			},
		};
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest(fromPersisted(f.intent.staged));
		const agentBytes = readFileSync(f.file);
		const intentBytes = readFileSync(intentPath);
		using errors = spyOn(logger, "error");
		using warnings = spyOn(logger, "warn");
		await using rpc = await streamRpcFixture();
		// When the real session admission reaches D8 through the real adapter.
		const request = rpc.request();
		if (fault === "guardian-observation") {
			await observed.promise;
			await prepareOsStageJob(
				{ ...record, attemptId: f.intent.attemptId, launched: false },
				jobDir,
				f.witnessDeps.uid,
			);
			jobBytes = readFileSync(jobPath);
			expect(readFileSync(f.file)).toEqual(agentBytes);
			held.resolve();
		}
		const reply = await request;
		// Then refusal is retryable, preserves every file and causes no RAUC work.
		expect(readFileSync(f.file)).toEqual(agentBytes);
		expect(readFileSync(intentPath)).toEqual(intentBytes);
		if (jobBytes) expect(readFileSync(jobPath)).toEqual(jobBytes);
		expect(kills).toBe(0);
		expect(rpc.launches()).toBe(0);
		expect(observations).toBeLessThanOrEqual(1);
		expect(
			errors.mock.calls.length + warnings.mock.calls.length,
		).toBeLessThanOrEqual(2);
		expect(reply.error).toEqual({
			code: "UPDATE_ORCHESTRATOR_INITIALIZING",
			retryable: true,
		});
		const refusal = rpc.failure();
		expect(refusal).toBeInstanceOf(ORPCError);
		if (!(refusal instanceof ORPCError)) throw refusal;
		expect(refusal.data).toEqual({ retryable: true });

		// Given repaired evidence, the same session can retry without a restart.
		if (fault === "unreadable-intent") unlinkSync(intentPath);
		writeFileSync(intentPath, JSON.stringify(f.intent), { mode: 0o600 });
		chmodSync(intentPath, 0o600);
		if (jobBytes) await retireOsStageJob(jobDir);
		repaired = true;
		setOrchestratorRuntimeDepsForTest({
			...deps,
			osAttemptIntentStore: f.intentStore,
		});
		// When a new stream request obtains positive restoration proof.
		const retry = await rpc.request();
		// Then exact recovery completed before the one stream launch.
		expect(retry.error).toBeUndefined();
		expect(retry.result?.result).toBe("started");
		expect(rpc.launches()).toBe(1);
		expect(kills).toBe(0);
		expect(getOrchestratorState()).toEqual(fromPersisted(f.intent.before));
		expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual(f.intent.before);
		expect(f.intentStore.read()).toBeNull();
	});
}
