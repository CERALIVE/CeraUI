import { afterEach, expect, test } from "bun:test";
import { parseDetachedAptServiceProbe } from "../modules/system/software-update-service-state.ts";
import { isCommitStageRunning } from "../modules/system/update-orchestrator/commit-stage-probe.ts";
import { createRecoveryProbes } from "../modules/system/update-orchestrator/recovery-probes.ts";
import { resumeOrchestratorState } from "../modules/system/update-orchestrator/resume.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { abortSpyDeps } from "./helpers/orchestrator-runtime-stream-admission.ts";

afterEach(resetOrchestratorRuntimeForTest);
const contradictions = [
	"LoadState=loaded\nActiveState=active\nSubState=running\nLoadState=not-found\n",
	"LoadState=not-found\nActiveState=active\nSubState=running\nControlGroup=/system.slice/ceralive-software-update.service\n",
	"LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=123\n",
	"LoadState=not-found\nActiveState=activating\nSubState=start\n",
];
test.each(contradictions)(
	"actual interrupted-download resume retains phase on %s",
	async (stdout) => {
		const persisted = {
			...initialOrchestratorState(0),
			phase: "downloading" as const,
		};
		const resumed = await resumeOrchestratorState(persisted, {
			recoverSoftwareUpdateIfRunning: async () =>
				parseDetachedAptServiceProbe({ stdout, stderr: "", exitCode: 0 }, [
					"systemctl",
					"show",
				]).kind !== "absent",
			lastInstallUnitVerdict: () => "absent",
			getUpdateState: () => ({ kind: "idle" }),
			now: () => 1000,
		});
		expect(resumed).toEqual(persisted);
	},
);
test.each(contradictions)(
	"package recovery refuses contradictory unit %s",
	(stdout) => {
		expect(() =>
			parseDetachedAptServiceProbe({ stdout, stderr: "", exitCode: 0 }, [
				"systemctl",
				"show",
			]),
		).toThrow();
	},
);
test.each(contradictions)(
	"D8 preserves downloading and submits no stop for %s",
	async (stdout) => {
		const { deps, calls } = abortSpyDeps({
			isCommitStageRunning: () =>
				isCommitStageRunning({
					showUnit: async () => ({ stdout, stderr: "", exitCode: 0 }),
					cgroupRoot: "/unused",
					procRoot: "/unused",
				}),
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "downloading",
		});
		const result = await admitAndPrepareStreamStart();
		expect(result.allowed).toBe(false);
		expect(calls.stop).toBe(0);
		expect(getOrchestratorState().phase).toBe("downloading");
	},
);
test.each(contradictions)(
	"maintenance refuses contradictory absence %s",
	async (stdout) => {
		const probes = createRecoveryProbes({
			run: async () => ({ stdout, code: 0, stderr: "" }),
			read: async () => "",
			list: async () => [],
		});
		await expect(probes.unitAbsent()).rejects.toThrow("unit_unreadable");
	},
);
test.each([0, 1, 4])(
	"genuine not-found exit %s remains absence",
	(exitCode) => {
		expect(
			parseDetachedAptServiceProbe(
				{
					stdout:
						"LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\n",
					stderr: "",
					exitCode,
				},
				["systemctl", "show"],
			),
		).toEqual({ kind: "absent" });
	},
);
