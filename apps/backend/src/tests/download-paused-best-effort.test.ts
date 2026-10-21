import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { trackAptTransfer } from "../modules/system/apt-transfer-abort.ts";
import { startOsStageAttempt } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	killAndRestartRaucForStream,
	stopPackageInstallUnitForStream,
} from "../modules/system/update-orchestrator/stream-abort.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { downloadNoticeFixture } from "./helpers/download-paused-fixture.ts";
import { quarantineDirs } from "./helpers/orchestrator-runtime-harness.ts";
import { abortSpyDeps } from "./helpers/orchestrator-runtime-stream-admission.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const root of quarantineDirs.splice(0))
		rmSync(root, { recursive: true });
});

test("nonzero package stop keeps cancellation-before-stop ordering and emits only a workflow hold", async () => {
	const notices = downloadNoticeFixture();
	const controller = new AbortController();
	const release = trackAptTransfer(controller);
	const seen: string[][] = [];
	const spawn = spyOn(spawnPolicy, "spawnWithTimeout").mockImplementation(
		async (argv) => {
			expect(controller.signal.aborted).toBe(true);
			seen.push([...argv]);
			return { exitCode: 1, stdout: "", stderr: "synthetic stop failure" };
		},
	);
	try {
		const { deps } = abortSpyDeps({
			downloadNotices: notices.worker,
			stopPackageInstallUnit: stopPackageInstallUnitForStream,
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		await notices.worker.settled();
		expect(getOrchestratorState().phase).toBe("available");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.slice(0, 2)).toEqual(["systemctl", "stop"]);
		expect(notices.publications).toHaveLength(1);
	} finally {
		spawn.mockRestore();
		release();
	}
});

test("nonzero RAUC TERM still produces the semantic hold after unchanged restart submission", async () => {
	const notices = downloadNoticeFixture();
	const seen: string[][] = [];
	const { deps } = abortSpyDeps({
		downloadNotices: notices.worker,
		killAndRestartRaucForStream: () =>
			killAndRestartRaucForStream(
				async (argv) => {
					seen.push(argv);
					return {
						exitCode: argv.includes("kill") ? 1 : 0,
						stdout: "",
						stderr: "",
					};
				},
				{ now: () => 0, schedule: () => () => undefined },
			),
	});
	setOrchestratorRuntimeDepsForTest(deps);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-staging",
		osStageRecovery: startOsStageAttempt(
			undefined,
			"candidate",
			"11111111-1111-4111-8111-111111111111",
		),
	});
	expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
	await notices.worker.settled();
	expect(seen).toEqual([
		["systemctl", "kill", "--signal=SIGTERM", "rauc.service"],
		["systemctl", "restart", "--no-block", "rauc.service"],
	]);
	expect(notices.publications).toEqual([
		"os:11111111-1111-4111-8111-111111111111",
	]);
});
