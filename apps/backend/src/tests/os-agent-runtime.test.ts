import { afterEach, describe, expect, test } from "bun:test";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	admitAndPrepareStreamStart,
	allowCellularOnce,
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	candidate,
	receipt,
	setup,
} from "./helpers/os-agent-runtime-harness.ts";

test("D8 cancels the stable stage signal and publishes abort before restart submission", async () => {
	// Given a stage held at its injected producer boundary.
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let cancelled = false;
	let phaseAtSubmission = "";
	setup({
		stageOs: async (_manifest, progress, control) => {
			if (!control) throw new Error("missing stage control");
			entered.resolve();
			await finish.promise;
			cancelled = control.signal.aborted;
			progress(100);
		},
		killAndRestartRaucForStream: async () => {
			phaseAtSubmission = getOrchestratorState().phase;
			finish.resolve();
		},
	});
	const install = installUpdatesNow();
	await entered.promise;
	// When the stream admission aborts this exact attempt.
	await admitAndPrepareStreamStart();
	await install;
	// Then late producer success/progress cannot turn it into a staged image.
	expect(cancelled).toBe(true);
	expect(phaseAtSubmission).toBe("os-available");
	expect(getOrchestratorState()).toMatchObject({
		phase: "os-available",
		progress: null,
		failureReason: null,
	});
});

test("the cellular grant is captured before OS_STAGING_STARTED consumes it", async () => {
	// Given approval for the exact candidate, when the stage producer is invoked.
	let approved = false;
	let grantAtInvocation: string | null = "unexpected";
	setup({
		onlyMeteredCandidateExists: async () => true,
		stageOs: async (_manifest, _progress, control) => {
			if (!control) throw new Error("missing stage control");
			approved = control.cellularApproved === true;
			grantAtInvocation = getOrchestratorState().cellularOverrideId;
		},
	});
	allowCellularOnce(candidate.version);
	await installUpdatesNow();
	// Then bounded failover carries the grant even though the reducer consumed it.
	expect(approved).toBe(true);
	expect(grantAtInvocation).toBeNull();
});

test("RAUC readiness joins the final stage-admission fence", async () => {
	// Given the restart is merely queued, when manual staging is requested.
	const h = setup({ isOsStageReady: async () => false });
	await installUpdatesNow();
	// Then no producer is invoked until positive readiness is available.
	expect(h.stages()).toBe(0);
	expect(getOrchestratorState().phase).toBe("os-available");
});

afterEach(() => resetOrchestratorRuntimeForTest());

describe("OS install dispatch", () => {
	test("does not call RAUC when stream is live", async () => {
		const { stages } = setup({ isStreamLive: () => true });
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "stream_active",
		});
		expect(stages()).toBe(0);
		expect(getOrchestratorState().phase).toBe("os-available");
	});

	test("legacy image refuses without calling RAUC", async () => {
		const { stages } = setup({
			loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		});
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "not_available",
		});
		expect(stages()).toBe(0);
	});

	test("missing release stamp propagates typed booted_version_unknown refusal", async () => {
		setup({
			runPackageCheck: async () => null,
			getPackageInstallWireState: () => ({ kind: "idle" }),
			checkOsManifest: async () => ({
				available: false,
				failed: true,
				rateLimited: false,
				reason: "booted_version_unknown",
			}),
		});
		setOrchestratorStateForTest(initialOrchestratorState(0));
		await checkUpdatesNow();
		expect(getOrchestratorState().failureReason).toBe("booted_version_unknown");
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "booted_version_unknown",
		});
	});

	test("metered OS download waits for the exact one-time approval", async () => {
		const { stages } = setup({ onlyMeteredCandidateExists: async () => true });
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "not_available",
		});
		expect(stages()).toBe(0);
	});

	test("manual install bypasses idle, stages once and arms without immediate activation", async () => {
		const calls: boolean[] = [];
		const { stages } = setup({
			isIdle: async () => false,
			armOs: async (now) => {
				calls.push(now);
			},
		});
		expect(await installUpdatesNow()).toEqual({ started: true });
		expect(stages()).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-staged");
		await runOrchestratorTick();
		expect(calls).toEqual([false]);
		expect(getOrchestratorState().phase).toBe("os-activation-armed");
	});

	test("a stage failure never becomes staged or armed", async () => {
		const calls: boolean[] = [];
		setup({
			stageOs: async () => {
				throw new Error("rauc failed");
			},
			armOs: async (now) => {
				calls.push(now);
			},
		});
		expect(await installUpdatesNow()).toEqual({
			started: false,
			reason: "not_available",
		});
		expect(getOrchestratorState().phase).toBe("failed");
		expect(calls).toEqual([]);
	});

	test("seven-day pending slot activates with --now only while no stream is live", async () => {
		const calls: boolean[] = [];
		setup({
			now: () => receipt.stagedAt + 7 * 24 * 60 * 60_000,
			armOs: async (now) => {
				calls.push(now);
			},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		await runOrchestratorTick();
		expect(calls).toEqual([true]);
		resetOrchestratorRuntimeForTest();
		setup({
			now: () => receipt.stagedAt + 7 * 24 * 60 * 60_000,
			isStreamLive: () => true,
			armOs: async (now) => {
				calls.push(now);
			},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		await runOrchestratorTick();
		expect(calls).toEqual([true]);
	});

	test("post-reboot mismatch quarantines the expected staged version", async () => {
		const recorded: string[] = [];
		class RecordingQuarantine extends UpdateQuarantine {
			override async recordOsRollback(expected: string): Promise<void> {
				recorded.push(expected);
			}
		}
		setup({
			readBootId: async () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			readBootedVersion: async () => "2026.9.0",
			// A rollback presupposes the activation ran; a reboot that activated
			// nothing is covered by os-activation-unclean-reboot.test.ts.
			readStagedActivation: async () => "consumed",
			quarantine: new RecordingQuarantine(),
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		await runOrchestratorTick();
		expect(recorded).toEqual(["2026.10.0"]);
		expect(getOrchestratorState().phase).toBe("quarantined");
	});

	test("a restarted backend never reissues an inconclusive RAUC install", async () => {
		const interrupted = {
			...initialOrchestratorState(0),
			phase: "os-staging" as const,
		};
		const { stages } = setup(
			{
				inspectOsOperation: async () => "idle",
				proveOsWriterQuiescent: async () => true,
			},
			interrupted,
		);
		setOrchestratorStateForTest(interrupted);
		await runOrchestratorTick();
		expect(stages()).toBe(0);
		expect(getOrchestratorState().phase).toBe("failed");
		expect(getOrchestratorState().failureReason).toBe(
			"os_stage_outcome_unknown_after_restart",
		);
	});
});
