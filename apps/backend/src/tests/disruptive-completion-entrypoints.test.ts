import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { SpawnTimeoutError } from "../helpers/bounded-spawn.ts";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import {
	resetSshServiceRunner,
	setSshServiceRunner,
} from "../modules/system/ssh.ts";
import {
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { reconcileStaleUnits } from "../modules/system/update-orchestrator/stale-services.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	poweroffProcedure,
	rebootProcedure,
	resetPowerCommandRunner,
	setPowerCommandRunner,
	sshStopProcedure,
} from "../rpc/procedures/system.procedure.ts";
import { receipt, setup } from "./helpers/os-agent-runtime-harness.ts";

const context = buildControlContext();
const env = { ...process.env };
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "power3-"));
	process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
});
afterEach(() => {
	resetSshServiceRunner();
	resetPowerCommandRunner();
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
	for (const key of ["NODE_ENV", "MOCK_MODE", "CERALIVE_STREAMING_MARKER"]) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	rmSync(dir, { recursive: true, force: true });
});

test("stale restart timeout releases on positive settled systemd evidence", async () => {
	// Given a timed-out client whose unit completed in PID 1.
	const probe = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
		exitCode: 0,
		stdout: "Job=0\nActiveState=active\nSubState=running\n",
		stderr: "",
	});
	// When the real reconciler receives uncertainty.
	try {
		await expect(
			reconcileStaleUnits({
				units: ["example.service"],
				isIdle: async () => true,
				transactionRunning: () => false,
				restart: async () => {
					throw new SpawnTimeoutError("restart");
				},
				recommend: () => {},
			}),
		).rejects.toBeInstanceOf(SpawnTimeoutError);
		await Promise.resolve();
		await Promise.resolve();
		// Then positive completion, not the client timer, clears exclusion.
		expect(isDisruptiveActionPending()).toBe(false);
		expect(probe).toHaveBeenCalledTimes(1);
	} finally {
		probe.mockRestore();
	}
});

test("SSH timeout releases on positive evidence and a healthy retry is admitted", async () => {
	// Given actual SSH RPC mutation with an uncertain client outcome.
	const probe = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
		exitCode: 0,
		stdout: "Job=0\nActiveState=inactive\nSubState=dead\n",
		stderr: "",
	});
	setSshServiceRunner(async () => {
		throw new SpawnTimeoutError("ssh");
	});
	try {
		// When PID 1 supplies settled evidence after the RPC reported failure.
		expect(await call(sshStopProcedure, undefined, { context })).toEqual({
			success: false,
		});
		await Promise.resolve();
		await Promise.resolve();
		// Then service exclusion is released without rewriting the operation result.
		expect(isDisruptiveActionPending()).toBe(false);
		const calls: string[] = [];
		setSshServiceRunner(async (action) => {
			calls.push(action);
		});
		await call(sshStopProcedure, undefined, { context });
		expect(calls).toEqual(["stop"]);
	} finally {
		probe.mockRestore();
	}
});

test("timed arm uncertainty releases only on positively failed terminal arm evidence", async () => {
	// Given the actual timed arm path and PID 1's completed failure.
	const probe = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
		exitCode: 0,
		stdout:
			"Job=0\nActiveState=failed\nSubState=failed\nExecMainCode=1\nExecMainStatus=1\nResult=exit-code\n",
		stderr: "",
	});
	setup({
		now: () => receipt.stagedAt + 7 * 24 * 60 * 60_000,
		armOs: async () => {
			throw new SpawnTimeoutError("arm");
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-activation-armed",
	});
	try {
		// When the real tick submits and observes uncertain arm completion.
		await expect(runOrchestratorTick()).rejects.toBeInstanceOf(
			SpawnTimeoutError,
		);
		await Promise.resolve();
		await Promise.resolve();
		// Then terminal failure resolves the reservation, not an arbitrary exception.
		expect(isDisruptiveActionPending()).toBe(false);
		expect(probe).toHaveBeenCalledTimes(1);
	} finally {
		probe.mockRestore();
	}
});

for (const [command, procedure] of [
	["reboot", rebootProcedure],
	["poweroff", poweroffProcedure],
] as const) {
	test(`same ${command} resubmission supersedes a stuck shutdown hold`, async () => {
		// Given exit-zero submission without physical shutdown.
		const calls: string[] = [];
		setPowerCommandRunner((action) => {
			calls.push(action);
		});
		await call(procedure, undefined, { context });
		// When the operator explicitly retries the SAME action.
		const retry = await call(procedure, undefined, { context });
		// Then retry reaches the command but continues excluding everything else.
		expect(retry).toEqual({ success: true });
		expect(calls).toEqual([command, command]);
		expect(isDisruptiveActionPending()).toBe(true);
	});
	for (const [liveness, reason] of [
		["streaming", "streaming"],
		["unknown", "stream_liveness_unknown"],
	] as const) {
		test(`retried ${command} refuses ${liveness} even with its own shutdown hold`, async () => {
			// Given a pending shutdown followed by restrictive current evidence.
			const calls: string[] = [];
			setPowerCommandRunner((action) => {
				calls.push(action);
			});
			await call(procedure, undefined, { context });
			if (liveness === "streaming") updateStatus(true);
			else updateStreamLifecycleState("starting");
			// When the same action is retried.
			const retry = await call(procedure, undefined, { context });
			// Then no hold is authority to bypass stream protection.
			expect(retry).toEqual({ success: false, error: reason });
			expect(calls).toEqual([command]);
		});
	}
}
