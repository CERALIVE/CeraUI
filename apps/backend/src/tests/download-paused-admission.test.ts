import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { downloadNoticeFixture } from "./helpers/download-paused-fixture.ts";
import { quarantineDirs } from "./helpers/orchestrator-runtime-harness.ts";
import { abortSpyDeps } from "./helpers/orchestrator-runtime-stream-admission.ts";

beforeEach(() => setStreamLivenessSourceForTest(() => "idle"));
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setStreamLivenessSourceForTest(null);
	for (const root of quarantineDirs.splice(0))
		rmSync(root, { recursive: true });
});
const downloading: UpdateState = {
	kind: "downloading",
	progress: { downloading: 1, unpacking: 0, setting_up: 0, total: 5 },
};

describe("DLP admission isolation", () => {
	test.each(["positive", "throws"])(
		"%s commit probe produces no hold or stop",
		async (fault) => {
			const notices = downloadNoticeFixture();
			const { deps, calls } = abortSpyDeps({
				downloadNotices: notices.worker,
				getPackageInstallWireState: () => downloading,
				isCommitStageRunning: async () => {
					if (fault === "throws") throw new Error("unreadable");
					return true;
				},
			});
			setOrchestratorRuntimeDepsForTest(deps);
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "downloading",
			});
			expect((await admitAndPrepareStreamStart()).allowed).toBe(false);
			await notices.worker.settled();
			expect(notices.publications).toEqual([]);
			expect(calls.stop).toBe(0);
		},
	);
	test("a rejected package stop preserves downloading and produces no hold", async () => {
		const notices = downloadNoticeFixture();
		const { deps } = abortSpyDeps({
			downloadNotices: notices.worker,
			getPackageInstallWireState: () => downloading,
			stopPackageInstallUnit: async () => {
				throw new Error("stop rejected");
			},
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		await expect(admitAndPrepareStreamStart()).rejects.toThrow("stop rejected");
		await notices.worker.settled();
		expect(notices.publications).toEqual([]);
		expect(getOrchestratorState().phase).toBe("downloading");
	});
	test("concurrent admissions and repeated ticks keep one package-attempt identity", async () => {
		const notices = downloadNoticeFixture();
		const gate = Promise.withResolvers<void>();
		const { deps, calls } = abortSpyDeps({
			downloadNotices: notices.worker,
			getPackageInstallWireState: () => downloading,
			stopPackageInstallUnit: () => {
				calls.stop++;
				return gate.promise;
			},
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		const first = admitAndPrepareStreamStart();
		const second = admitAndPrepareStreamStart();
		gate.resolve();
		expect(await Promise.all([first, second])).toEqual([
			{ allowed: true },
			{ allowed: true },
		]);
		await notices.worker.settled();
		expect(notices.entries()).toHaveLength(1);
		expect(notices.publications).toHaveLength(1);
		expect(notices.entries()[0]?.id).toMatch(/^packages:[0-9a-f-]{36}$/);
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		await notices.worker.settled();
		expect(notices.entries()).toHaveLength(1);
	});
	test("accepted retry withdraws the old hold and its next interruption is a new attempt", async () => {
		const notices = downloadNoticeFixture();
		const { deps } = abortSpyDeps({
			downloadNotices: notices.worker,
			getPackageInstallWireState: () => downloading,
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		expect(await installUpdatesNow()).toEqual({ started: true });
		await admitAndPrepareStreamStart();
		await notices.worker.settled();
		const first = notices.entries()[0]?.id;
		expect(first).toBeDefined();
		expect(await installUpdatesNow()).toEqual({ started: true });
		await notices.worker.settled();
		expect(notices.entries()[0]?.status).toBe("withdrawn");
		await admitAndPrepareStreamStart();
		await notices.worker.settled();
		expect(notices.entries()).toHaveLength(2);
		expect(notices.entries()[1]?.id).not.toBe(first);
	});
	test("already-live installation refusal is not an interruption", async () => {
		const notices = downloadNoticeFixture();
		const { deps } = abortSpyDeps({
			downloadNotices: notices.worker,
			isStreamLive: () => true,
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "stream_active",
		});
		await runOrchestratorTick();
		await notices.worker.settled();
		expect(notices.entries()).toEqual([]);
	});
	test("late aborted package wire success cannot promote the old attempt to installed", async () => {
		const notices = downloadNoticeFixture();
		let wire: UpdateState = downloading;
		let live = false;
		const { deps } = abortSpyDeps({
			downloadNotices: notices.worker,
			getPackageInstallWireState: () => wire,
			isStreamLive: () => live,
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		await admitAndPrepareStreamStart();
		wire = { kind: "success" };
		live = true;
		await runOrchestratorTick();
		await notices.worker.settled();
		expect(getOrchestratorState().phase).toBe("awaiting-idle");
		expect(notices.publications).toHaveLength(1);
	});
});
