import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import {
	isDisruptiveActionPending,
	isPositiveDisruptiveFailure,
} from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import {
	armOsActivation,
	OsAgentError,
} from "../modules/system/update-orchestrator/os-agent.ts";
import {
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { receipt, setup } from "./helpers/os-agent-runtime-harness.ts";
import {
	completionFixture,
	evidenceJobs,
} from "./helpers/sysext-completion-fixture.ts";

useSessionOwnerForFile();
let f: ReturnType<typeof completionFixture>;
beforeEach(() => {
	f = completionFixture();
});
afterEach(() => f.reset());

for (const exitCode of [137, 143, 1] as const) {
	test(`real timed arm exit ${exitCode} preserves client evidence and runtime settlement`, async () => {
		// Given the actual arm producer inside the actual timed-runtime scope.
		let settled = exitCode === 1;
		let probes = 0;
		const probe = spyOn(spawnPolicy, "spawnWithTimeout").mockImplementation(
			async (argv) => {
				if (argv[1] === "start")
					return { exitCode, stdout: "", stderr: "arm client exited" };
				probes++;
				return {
					exitCode: 0,
					stderr: "",
					stdout: settled
						? "Job=0\nActiveState=failed\nSubState=failed\nExecMainCode=1\nExecMainStatus=1\nResult=exit-code\n"
						: "Job=9\nActiveState=activating\nSubState=start\n",
				};
			},
		);
		setup({
			now: () => receipt.stagedAt + 7 * 24 * 60 * 60_000,
			armOs: armOsActivation,
			isUpdateAdmissionReady: async () => true,
			readOsStageJob: async () => null,
			readOsUnlaunchedWitness: () => null,
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "os-activation-armed",
		});
		try {
			expect(getDisruptiveActionDecision()).toEqual({ allowed: true });
			// When systemctl returns its original nonzero exit through the real producer.
			const error = await runOrchestratorTick().catch(
				(caught: unknown) => caught,
			);
			await evidenceJobs();
			// Then the reason is honest but never replaces signal/exit evidence.
			expect(error).toBeInstanceOf(OsAgentError);
			if (!(error instanceof OsAgentError))
				throw new Error("missing typed arm result");
			expect(error.reason).toBe("activation_arm_failed");
			expect(isPositiveDisruptiveFailure(error)).toBe(exitCode === 1);
			expect(isDisruptiveActionPending()).toBe(exitCode !== 1);
			expect(probes).toBe(exitCode === 1 ? 0 : 1);
			if (exitCode !== 1) {
				settled = true;
				await f.wake();
				expect(isDisruptiveActionPending()).toBe(false);
			}
		} finally {
			probe.mockRestore();
		}
	});
}
