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
import {
	isDisruptiveActionPending,
	PowerSubmissionError,
} from "../modules/system/disruptive-action-reservation.ts";
import { setDisruptiveRetryClockForTest } from "../modules/system/disruptive-retry.ts";
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

const env = { ...process.env };
const context = buildControlContext();
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "power3-holds-"));
	process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
});
afterEach(() => {
	setDisruptiveRetryClockForTest(null);
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

for (const entry of ["stale", "ssh", "arm"] as const) {
	for (const evidence of ["running-job", "unreachable"] as const) {
		test(`${entry} timeout holds while ${evidence} and resolves only with positive completion`, async () => {
			// Given a real entry point and PID 1 initially unable to prove settlement.
			const wakeups: (() => Promise<void>)[] = [];
			setDisruptiveRetryClockForTest({
				schedule: (run) => {
					wakeups.push(run);
					return () => {};
				},
			});
			let settled = false;
			let probes = 0;
			const probe = spyOn(spawnPolicy, "spawnWithTimeout").mockImplementation(
				async () => {
					probes++;
					if (!settled && evidence === "unreachable")
						throw new SpawnTimeoutError("show");
					return {
						exitCode: 0,
						stdout: settled
							? "Job=0\nActiveState=failed\nSubState=failed\nExecMainCode=1\nExecMainStatus=1\nResult=exit-code\n"
							: "Job=7\nActiveState=active\nSubState=running\n",
						stderr: "",
					};
				},
			);
			try {
				// When the actual bounded effect times out, then the probe is retried.
				switch (entry) {
					case "stale":
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
						break;
					case "ssh":
						setSshServiceRunner(async () => {
							throw new SpawnTimeoutError("ssh");
						});
						expect(
							await call(sshStopProcedure, undefined, { context }),
						).toEqual({ success: false });
						break;
					case "arm":
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
						await expect(runOrchestratorTick()).rejects.toBeInstanceOf(
							SpawnTimeoutError,
						);
						break;
					default: {
						const exhaustive: never = entry;
						throw exhaustive;
					}
				}
				await Promise.resolve();
				await Promise.resolve();
				await wakeups.shift()?.();
				expect(isDisruptiveActionPending()).toBe(true);
				settled = true;
				await wakeups.shift()?.();
				// Then both entry-point refusal and bounded observer remain honest.
				expect(isDisruptiveActionPending()).toBe(false);
				expect(probes).toBe(3);
			} finally {
				probe.mockRestore();
			}
		});
	}
}

test("failed power retry preserves an earlier possibly accepted shutdown", async () => {
	// Given an earlier accepted reboot and a failed retry.
	setPowerCommandRunner(() => {});
	await call(rebootProcedure, undefined, { context });
	setPowerCommandRunner(() => {
		throw new PowerSubmissionError("reboot", 1);
	});
	// When the explicit retry fails positively.
	const result = await call(rebootProcedure, undefined, { context });
	// Then failure of the second submission cannot disprove the first.
	expect(result).toEqual({
		success: false,
		error: "reboot exited with status 1",
	});
	expect(isDisruptiveActionPending()).toBe(true);
	expect(await call(poweroffProcedure, undefined, { context })).toEqual({
		success: false,
		error: "update_in_progress",
	});
});

test("uncertain timed arm with successful terminal evidence retains shutdown and permits explicit reboot retry", async () => {
	// Given an unknown client outcome but positive terminal arm success.
	const probe = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
		exitCode: 0,
		stdout:
			"Job=0\nActiveState=inactive\nSubState=dead\nExecMainCode=1\nExecMainStatus=0\nResult=success\n",
		stderr: "",
	});
	setup({
		now: () => receipt.stagedAt + 7 * 24 * 60 * 60_000,
		armOs: async () => {
			throw new Error("uncertain arm");
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-activation-armed",
	});
	const calls: string[] = [];
	setPowerCommandRunner((command) => {
		calls.push(command);
	});
	try {
		// When the real arm entry receives its uncertain result and the operator retries.
		await expect(runOrchestratorTick()).rejects.toThrow("uncertain arm");
		await Promise.resolve();
		await Promise.resolve();
		expect(isDisruptiveActionPending()).toBe(true);
		const retry = await call(rebootProcedure, undefined, { context });
		// Then successful arming cannot open a start window but has a fenced escape.
		expect(retry).toEqual({ success: true });
		expect(calls).toEqual(["reboot"]);
		expect(isDisruptiveActionPending()).toBe(true);
	} finally {
		probe.mockRestore();
	}
});

for (const phase of ["committing", "os-staging", "syncing"] as const) {
	test(`power resubmission refuses a current ${phase} fence`, async () => {
		// Given accepted power followed by current update authority.
		const calls: string[] = [];
		setPowerCommandRunner((command) => {
			calls.push(command);
		});
		await call(rebootProcedure, undefined, { context });
		setOrchestratorStateForTest({ ...initialOrchestratorState(0), phase });
		// When the same power action is retried.
		const retry = await call(rebootProcedure, undefined, { context });
		// Then same-action escape bypasses no update fence.
		expect(retry).toEqual({ success: false, error: "update_in_progress" });
		expect(calls).toEqual(["reboot"]);
	});
}
