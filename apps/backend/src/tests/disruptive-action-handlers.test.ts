import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { createSeenCidStore } from "../modules/remote-control/command-idempotency.ts";
import { routeCommand } from "../modules/remote-control/command-router.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import type { Command, Result } from "../modules/remote-control/protocol.ts";
import { resetSelfFencingState } from "../modules/remote-control/self-fencing.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import {
	resetOrchestratorRuntimeForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorPhase,
} from "../modules/system/update-orchestrator/types.ts";
import {
	poweroffProcedure,
	rebootProcedure,
	resetPowerCommandRunner,
	setPowerCommandRunner,
} from "../rpc/procedures/system.procedure.ts";

const savedEnv = {
	NODE_ENV: process.env.NODE_ENV,
	MOCK_MODE: process.env.MOCK_MODE,
	CERALIVE_STREAMING_MARKER: process.env.CERALIVE_STREAMING_MARKER,
};
const context = buildControlContext();
let commands: string[] = [];
let dir = "";

beforeEach(() => {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	dir = mkdtempSync(join(tmpdir(), "disruptive-action-"));
	process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
	setStreamReconciliationCompletedForTest(true);
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
	commands = [];
	setPowerCommandRunner((command) => {
		commands.push(command);
	});
});
afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetPowerCommandRunner();
	resetSelfFencingState();
	resetOrchestratorRuntimeForTest();
	setStreamReconciliationCompletedForTest(true);
	updateStatus(false);
	updateStreamLifecycleState("idle");
	rmSync(dir, { recursive: true, force: true });
});

const local = { reboot: rebootProcedure, poweroff: poweroffProcedure } as const;

async function localAction(action: keyof typeof local) {
	const result = await call(local[action], undefined, { context });
	return { ran: commands.length > 0, ok: result.success, error: result.error };
}

async function remoteReboot(exitCode = 0, beforeConfirm?: () => void) {
	const frames: Result[] = [];
	const submitted: unknown[] = [];
	const safe = Bun.spawnSync(["true"]);
	const spawn = spyOn(Bun, "spawnSync").mockImplementation((argv) => {
		submitted.push(argv);
		return { ...safe, exitCode, success: exitCode === 0 };
	});
	const frame: Command = {
		v: 1,
		kind: "command",
		type: "system.reboot",
		cid: "b3-reboot",
		role: "owner",
	};
	const deps = {
		context,
		seenCids: createSeenCidStore(),
		sendResult: (result: Result) => frames.push(result) > 0,
		sendDeliveryAck: () => true,
	};
	try {
		await routeCommand(frame, deps);
		const early = submitted.length;
		beforeConfirm?.();
		await routeCommand({ ...frame, type: "self_fencing.confirm" }, deps);
		const last = frames.at(-1)?.payload;
		return {
			ran: submitted.length > 0,
			early,
			ok: last?.ok,
			error: last?.error,
		};
	} finally {
		spawn.mockRestore();
	}
}

for (const action of ["reboot", "poweroff"] as const) {
	for (const phase of [
		"downloading",
		"committing",
		"restarting-services",
		"os-staging",
		"syncing",
	] satisfies OrchestratorPhase[]) {
		test(`local ${action} refuses ${phase} without package progress`, async () => {
			// Given independent update authority and no legacy package progress.
			setOrchestratorStateForTest({ ...initialOrchestratorState(1), phase });
			// When the real authenticated procedure executes.
			const result = await localAction(action);
			// Then no host power command is submitted and the refusal is typed.
			expect(result).toEqual({
				ran: false,
				ok: false,
				error: "update_in_progress",
			});
		});
	}
	test(`local ${action} refuses a reconciling survived engine`, async () => {
		// Given the live projection is false while liveness is being reconciled.
		updateStreamLifecycleState("reconciling");
		// When the real handler runs.
		const result = await localAction(action);
		// Then uncertainty is not permission.
		expect(result).toEqual({
			ran: false,
			ok: false,
			error: "stream_liveness_unknown",
		});
	});
	test(`local ${action} refuses before boot reconciliation returned`, async () => {
		// Given a restarted backend whose control server answers before reconciliation.
		setStreamReconciliationCompletedForTest(false);
		// When the real handler runs on the factory's initial idle projection.
		const result = await localAction(action);
		// Then that projection is not idle evidence.
		expect(result).toEqual({
			ran: false,
			ok: false,
			error: "stream_liveness_unknown",
		});
	});
	test(`local ${action} refuses an unreadable OTA sentinel`, async () => {
		// Given a sentinel path whose parent is a regular file (ENOTDIR, not ENOENT).
		writeFileSync(join(dir, "file"), "");
		process.env.CERALIVE_STREAMING_MARKER = join(dir, "file", "streaming");
		// When the real handler runs.
		const result = await localAction(action);
		// Then an unreadable sentinel is not absence.
		expect(result).toEqual({
			ran: false,
			ok: false,
			error: "stream_liveness_unknown",
		});
	});
	test(`local ${action} refuses success before durable acknowledgement`, async () => {
		// Given APT completion retained after its progress has cleared.
		const baseline = {
			...initialOrchestratorState(1),
			phase: "committing" as const,
		};
		pendingPackageSuccess.retain(baseline, {
			...baseline,
			phase: "restarting-services",
		});
		// When a power request reaches the actual handler.
		const result = await localAction(action);
		// Then the retained completion cannot be lost by this request.
		expect(result).toEqual({
			ran: false,
			ok: false,
			error: "update_in_progress",
		});
	});
	test(`local ${action} proceeds on confirmed idle with no update work`, async () => {
		// Given reconciled idle evidence and an idle orchestrator.
		// When the real handler runs.
		const result = await localAction(action);
		// Then the host command is submitted once.
		expect(result.ok).toBe(true);
		expect(commands).toEqual([action]);
	});
}

test("remote confirmed reboot refuses a live stream before any watchdog", async () => {
	// Given a legitimate owner and a confirmed live engine.
	updateStatus(true);
	// When the real router receives the command and a confirm.
	const result = await remoteReboot();
	// Then nothing runs and the requester gets the typed refusal.
	expect(result).toEqual({
		ran: false,
		early: 0,
		ok: false,
		error: "streaming",
	});
});
test("remote confirm re-reads the gate when a stream starts inside the watchdog", async () => {
	// Given an idle device at receipt.
	// When a stream goes live between the command and its confirm.
	const result = await remoteReboot(0, () => updateStatus(true));
	// Then the confirm does not override stream exclusion.
	expect(result).toEqual({
		ran: false,
		early: 0,
		ok: false,
		error: "streaming",
	});
});
test("remote confirmed reboot refuses OS staging", async () => {
	// Given OS staging with no package progress.
	setOrchestratorStateForTest({
		...initialOrchestratorState(1),
		phase: "os-staging",
	});
	// When the owner confirms.
	const result = await remoteReboot();
	// Then the staging is not interrupted.
	expect(result).toEqual({
		ran: false,
		early: 0,
		ok: false,
		error: "update_in_progress",
	});
});
test("remote confirmed reboot reports a nonzero host exit honestly", async () => {
	// Given an idle host whose reboot command fails.
	// When the default op settles with exit 1.
	const result = await remoteReboot(1);
	// Then the requester receives a negative result naming the status.
	expect(result).toEqual({
		ran: true,
		early: 0,
		ok: false,
		error: "reboot exited with status 1",
	});
});
test("remote confirmed reboot proceeds on confirmed idle", async () => {
	// Given confirmed idle and no update work.
	// When the owner confirms.
	const result = await remoteReboot();
	// Then the reboot is submitted after, never before, the confirm.
	expect(result).toEqual({ ran: true, early: 0, ok: true, error: undefined });
});
