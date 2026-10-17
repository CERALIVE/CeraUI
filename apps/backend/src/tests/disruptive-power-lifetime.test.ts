import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import type { Command, Result } from "../modules/remote-control/protocol.ts";
import {
	handleSelfFencingConfirm,
	handleSelfFencingOp,
	resetSelfFencingState,
} from "../modules/remote-control/self-fencing.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import {
	getIsStreaming,
	updateStatus,
} from "../modules/streaming/streaming.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import {
	markBootDegraded,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import {
	rebootAfterUpdate,
	resetRebootRunner,
	setRebootRunner,
} from "../modules/system/software-updates.ts";
import {
	admitAndPrepareStreamStart,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	setStreamingProcedureDepsForTest,
	streamingStartProcedure,
} from "../rpc/procedures/streaming.procedure.ts";
import {
	poweroffProcedure,
	rebootProcedure,
	resetPowerCommandRunner,
	setPowerCommandRunner,
} from "../rpc/procedures/system.procedure.ts";

const context = buildControlContext();
const env = { ...process.env };
let dir = "";
beforeEach(() => {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	dir = mkdtempSync(join(tmpdir(), "power-lifetime-"));
	process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
});
afterEach(() => {
	resetPowerCommandRunner();
	setStreamingProcedureDepsForTest(null);
	resetRebootRunner();
	resetSelfFencingState();
	resetOrchestratorRuntimeForTest();
	resetBootReadiness();
	updateStatus(false);
	updateStreamLifecycleState("idle");
	for (const key of ["NODE_ENV", "MOCK_MODE", "CERALIVE_STREAMING_MARKER"]) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	rmSync(dir, { recursive: true, force: true });
});

for (const type of ["system.reboot", "device.factoryReset"] as const) {
	test(`${type} refuses a stream that wins the confirm admission await`, async () => {
		// Given an idle receipt, with a stream queued behind the confirm snapshot.
		const frames: Result[] = [];
		const effects: boolean[] = [];
		let reads = 0;
		const frame: Command = {
			v: 1,
			kind: "command",
			type,
			cid: type,
			role: "owner",
		};
		const execute = async () => {
			effects.push(getIsStreaming());
		};
		await handleSelfFencingOp(frame, {
			sendResult: (result) => frames.push(result) > 0,
			ops: {
				"system.reboot": { revertible: false, execute },
				"device.factoryReset": { revertible: false, execute },
				"network.reconfig": { revertible: false, execute },
				"modem.reconfig": { revertible: false, execute },
				"device.remoteKeyChange": { revertible: false, execute },
			},
			admitDisruptiveAction: async () => {
				reads++;
				if (reads === 2) queueMicrotask(() => updateStatus(true));
				return { ok: true };
			},
		});
		// When the actual confirmation resumes after that continuation.
		await handleSelfFencingConfirm(type);
		// Then final current evidence refuses and no effect is submitted.
		expect(effects).toEqual([]);
		expect(frames[frames.length - 1]?.payload).toEqual({
			ok: false,
			applied: null,
			error: "streaming",
		});
	});
	test(`${type} excludes stream admission when power wins the final check`, async () => {
		// Given a confirmed idle device and the real default privileged op.
		const frames: Result[] = [];
		const safe = Bun.spawnSync(["true"]);
		const spawn = spyOn(Bun, "spawnSync").mockReturnValue(safe);
		const frame: Command = {
			v: 1,
			kind: "command",
			type,
			cid: type,
			role: "owner",
		};
		try {
			await handleSelfFencingOp(frame, {
				sendResult: (result) => frames.push(result) > 0,
			});
			await handleSelfFencingConfirm(type);
			// When a start reaches the shared production D8 admission after submission.
			const start = await admitAndPrepareStreamStart();
			// Then accepted power remains exclusive even after exit zero.
			expect(frames[frames.length - 1]?.payload).toEqual({
				ok: true,
				applied: null,
			});
			expect(start).toEqual({
				allowed: false,
				reason: "update_in_progress",
				phase: "committing",
				percent: 0,
				etaSeconds: 0,
			});
		} finally {
			spawn.mockRestore();
		}
	});
}

for (const [command, procedure] of [
	["reboot", rebootProcedure],
	["poweroff", poweroffProcedure],
] as const) {
	test(`local ${command} reports exit one honestly and permits retry`, async () => {
		// Given the actual native runner returning positive failure evidence.
		const safe = Bun.spawnSync(["true"]);
		const spawn = spyOn(Bun, "spawnSync").mockReturnValue({
			...safe,
			exitCode: 1,
			success: false,
		});
		try {
			// When the authenticated production procedure submits power.
			const result = await call(procedure, undefined, { context });
			// Then failed submission is not success or a permanent exclusion.
			expect(result).toEqual({
				success: false,
				error: `${command} exited with status 1`,
			});
			expect(getDisruptiveActionDecision()).toEqual({ allowed: true });
		} finally {
			spawn.mockRestore();
		}
	});
	test(`local ${command} retains exclusion after successful submission`, async () => {
		// Given a successful synchronous command sink.
		setPowerCommandRunner(() => {});
		await call(procedure, undefined, { context });
		// When the backend keeps answering before shutdown.
		const result = await admitAndPrepareStreamStart();
		// Then no timer or successful command return grants a start.
		expect(result).toEqual({
			allowed: false,
			reason: "update_in_progress",
			phase: "committing",
			percent: 0,
			etaSeconds: 0,
		});
		expect(getDisruptiveActionDecision()).toEqual({
			allowed: false,
			reason: "update_in_progress",
		});
	});
}

test("historical maintenance clears power refusal only with current settled authority", () => {
	// Given historical degradation after a positively reconciled runtime recovered.
	setOrchestratorRuntimeDepsForTest({});
	markBootDegraded("update-orchestrator-maintenance");
	// When the shared production gate evaluates current evidence.
	const result = getDisruptiveActionDecision();
	// Then history alone does not permanently prevent recovery actions.
	expect(result).toEqual({ allowed: true });
});

test("legacy completion reboot reserves the shutdown lifetime", async () => {
	// Given a completed update with a successful reboot submission sink.
	setRebootRunner(() => {});
	rebootAfterUpdate();
	// When a start reaches the existing shared admission after completion reboot.
	const result = await admitAndPrepareStreamStart();
	// Then completion-owned reboot does not leave a new launch window.
	expect(result).toEqual({
		allowed: false,
		reason: "update_in_progress",
		phase: "committing",
		percent: 0,
		etaSeconds: 0,
	});
});

test("actual Go Live RPC returns the existing typed refusal during pending shutdown", async () => {
	// Given accepted reboot with the backend still reachable.
	setPowerCommandRunner(() => {});
	await call(rebootProcedure, undefined, { context });
	setStreamingProcedureDepsForTest({
		startStream: async () => {
			throw new Error("unexpected launch");
		},
	});
	// When the real stream-start procedure enters its shared admission hook.
	const result = await call(streamingStartProcedure, {}, { context });
	// Then no launch path replaces the existing typed update exclusion.
	expect(result).toMatchObject({
		success: false,
		is_streaming: false,
		result: "failed",
		failure: { phase: "params", class: "update_in_progress", retriable: false },
	});
});
