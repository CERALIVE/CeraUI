import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { downloadNoticeFixture } from "./helpers/download-paused-fixture.ts";
import { setup } from "./helpers/os-agent-runtime-harness.ts";

let notices: ReturnType<typeof downloadNoticeFixture>;
beforeEach(() => {
	setStreamLivenessSourceForTest(() => "idle");
	notices = downloadNoticeFixture();
});
afterEach(async () => {
	await notices.worker.settled();
	resetOrchestratorRuntimeForTest();
	setStreamLivenessSourceForTest(null);
});

function stageFixture(kill: () => Promise<void> = async () => undefined) {
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let signal: AbortSignal | undefined;
	setup({
		downloadNotices: notices.worker,
		stageOs: async (_manifest, _progress, control) => {
			signal = control?.signal;
			entered.resolve();
			await finish.promise;
		},
		killAndRestartRaucForStream: kill,
	});
	return { entered, finish, signal: () => signal };
}

describe("OS download hold production-site mapping", () => {
	test("slow restart submission cannot run notice I/O before admission settles", async () => {
		const held = Promise.withResolvers<void>();
		const killing = Promise.withResolvers<void>();
		const f = stageFixture(() => {
			killing.resolve();
			return held.promise;
		});
		const install = installUpdatesNow();
		await f.entered.promise;
		const attempt = getOrchestratorState().osStageRecovery?.activeAttemptId;
		const admission = admitAndPrepareStreamStart();
		await killing.promise;
		expect(f.signal()?.aborted).toBe(true);
		expect(getOrchestratorState().phase).toBe("os-available");
		await notices.worker.settled();
		expect(notices.entries()).toEqual([]);
		setOrchestratorStateForTest({
			...getOrchestratorState(),
			phase: "checking",
		});
		held.resolve();
		expect(await admission).toEqual({ allowed: true });
		await notices.worker.settled();
		expect(notices.publications).toEqual([`os:${attempt}`]);
		f.finish.resolve();
		await install;
	});
	test("concurrent starts join one OS interruption and late success cannot stage it", async () => {
		let kills = 0;
		const f = stageFixture(async () => {
			kills++;
		});
		const install = installUpdatesNow();
		await f.entered.promise;
		const attempt = getOrchestratorState().osStageRecovery?.activeAttemptId;
		expect(
			await Promise.all([
				admitAndPrepareStreamStart(),
				admitAndPrepareStreamStart(),
			]),
		).toEqual([{ allowed: true }, { allowed: true }]);
		await notices.worker.settled();
		expect(kills).toBe(1);
		expect(notices.publications).toEqual([`os:${attempt}`]);
		f.finish.resolve();
		await install;
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(getOrchestratorState().osStageRecovery?.failedRounds).toBe(0);
	});
	test("restart rejection still records the semantic hold without hiding the original error", async () => {
		const f = stageFixture(async () => {
			throw new Error("submission rejected");
		});
		const install = installUpdatesNow();
		await f.entered.promise;
		await expect(admitAndPrepareStreamStart()).rejects.toThrow(
			"submission rejected",
		);
		await notices.worker.settled();
		expect(notices.publications).toHaveLength(1);
		expect(getOrchestratorState().phase).toBe("os-available");
		f.finish.resolve();
		await install;
	});
	test("a later OS attempt gets a new identity and withdraws the previous hold on resume", async () => {
		const first = stageFixture();
		const firstInstall = installUpdatesNow();
		await first.entered.promise;
		await admitAndPrepareStreamStart();
		await notices.worker.settled();
		const firstId = notices.entries()[0]?.id;
		first.finish.resolve();
		await firstInstall;
		const second = stageFixture();
		const secondInstall = installUpdatesNow();
		await second.entered.promise;
		await notices.worker.settled();
		expect(notices.entries()[0]?.status).toBe("withdrawn");
		await admitAndPrepareStreamStart();
		await notices.worker.settled();
		expect(notices.entries()).toHaveLength(2);
		expect(notices.entries()[1]?.id).not.toBe(firstId);
		second.finish.resolve();
		await secondInstall;
	});
	test("a producer's unrelated cancellation does not manufacture a stream event", async () => {
		setup({
			downloadNotices: notices.worker,
			stageOs: async () => {
				throw new OsStageError("os_stage_cancelled_for_stream");
			},
		});
		await installUpdatesNow();
		await notices.worker.settled();
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(notices.entries()).toEqual([]);
	});
	test("already-live OS admission creates no interruption intent", async () => {
		setup({ downloadNotices: notices.worker, isStreamLive: () => true });
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "stream_active",
		});
		await notices.worker.settled();
		expect(notices.entries()).toEqual([]);
	});
	test("later engine launch failure does not erase the genuine interruption", async () => {
		const f = stageFixture();
		const install = installUpdatesNow();
		await f.entered.promise;
		const session = createStreamSessionOrchestrator({
			createAttemptId: () => "start-after-hold",
			setStreamingStatus: () => undefined,
			stopRuntime: async () => undefined,
			queryRuntime: async () => "idle",
			admitUpdate: admitAndPrepareStreamStart,
		});
		const result = await session.start({
			origin: "ui",
			launch: async () => {
				throw new Error("engine refused launch");
			},
		});
		expect(result.result).not.toBe("started");
		await notices.worker.settled();
		expect(notices.publications).toHaveLength(1);
		f.finish.resolve();
		await install;
		expect(getOrchestratorState().phase).toBe("os-available");
	});
});
