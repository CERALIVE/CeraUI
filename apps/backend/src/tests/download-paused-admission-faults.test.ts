import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { UpdateState } from "@ceraui/rpc/schemas";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import { startOsStageAttempt } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
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
const attemptId = "11111111-1111-4111-8111-111111111111";

for (const phase of ["downloading", "os-staging"] as const) {
	for (const port of ["ledger", "publisher"] as const) {
		for (const fault of ["slow", "throws", "rejects"] as const) {
			test(`${phase}: ${fault} ${port} cannot enter the admission critical path`, async () => {
				const trace: string[] = [];
				const held = Promise.withResolvers<void>();
				const entered = Promise.withResolvers<void>();
				const fail = () => {
					entered.resolve();
					trace.push("notice");
					switch (fault) {
						case "slow":
							return held.promise;
						case "throws":
							throw new Error("synthetic private fault");
						case "rejects":
							return Promise.reject(new Error("synthetic private fault"));
						default: {
							const exhaustive: never = fault;
							return exhaustive;
						}
					}
				};
				const notices = downloadNoticeFixture({
					ledger: {
						read: () => {
							trace.push("notice-read");
							return [];
						},
						write: port === "ledger" ? fail : () => undefined,
						acknowledge: () => undefined,
					},
					...(port === "publisher" ? { publish: fail } : {}),
				});
				const { deps } = abortSpyDeps({
					downloadNotices: notices.worker,
					getPackageInstallWireState: () => downloading,
					isCommitStageRunning: async () => {
						trace.push("probe");
						return false;
					},
					stopPackageInstallUnit: async () => {
						trace.push("stop");
					},
					killAndRestartRaucForStream: async () => {
						trace.push("kill");
					},
					persist: (state) => {
						trace.push(`persist:${state.phase}`);
					},
					publishWireState: (wire) => {
						trace.push(`wire:${wire.phase}`);
					},
				});
				setOrchestratorRuntimeDepsForTest(deps);
				setOrchestratorStateForTest({
					...initialOrchestratorState(0),
					phase,
					...(phase === "os-staging"
						? {
								osStageRecovery: startOsStageAttempt(
									undefined,
									"candidate",
									attemptId,
								),
							}
						: {}),
				});
				const result = await admitAndPrepareStreamStart();
				trace.push("admitted");
				expect(result).toEqual({ allowed: true });
				expect(trace).toEqual(
					phase === "downloading"
						? [
								"probe",
								"stop",
								"persist:available",
								"wire:available",
								"admitted",
							]
						: ["persist:os-available", "wire:os-available", "kill", "admitted"],
				);
				expect(getOrchestratorState().phase).toBe(
					phase === "downloading" ? "available" : "os-available",
				);
				await entered.promise;
				held.resolve();
				await notices.worker.settled();
				expect(notices.diagnostics).toEqual(
					fault === "slow"
						? []
						: [port === "ledger" ? "write-failed" : "publication-failed"],
				);
			});
		}
	}
}
