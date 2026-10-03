import type { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { proveOsGuardKernelOwnership } from "./os-stage-guard-lock.ts";
import type { OsStageGuardObservation } from "./os-stage-guard-observation.ts";
import { OS_STAGE_GUARD_UNIT } from "./os-stage-job-files.ts";

export async function retireReleasedOsStageGuard(deps: {
	readonly inspect: () => Promise<OsStageGuardObservation>;
	readonly kernel: typeof proveOsGuardKernelOwnership;
	readonly jobIdle: () => Promise<boolean>;
	readonly attemptId: string;
	readonly run: typeof spawnWithTimeout;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
}): Promise<void> {
	const deadline = deps.now() + 10_000;
	do {
		const observation = await deps.inspect();
		if (observation.kind === "absent") {
			if (!(await deps.kernel({ pid: null, attemptId: deps.attemptId })))
				throw new OsStageError("rauc_recovery_unproven");
			return;
		}
		if (observation.kind === "terminal" && observation.cleanExit) {
			if (
				!(await deps.kernel({ pid: null, attemptId: deps.attemptId })) ||
				!(await deps.jobIdle())
			)
				throw new OsStageError("rauc_recovery_unproven");
			const stopped = await deps.run(
				["systemctl", "stop", OS_STAGE_GUARD_UNIT],
				{ timeoutMs: 10_000 },
			);
			if (stopped.exitCode !== 0)
				throw new OsStageError("rauc_recovery_unproven", { cause: stopped });
			const after = await deps.inspect();
			if (
				after.kind === "terminal" &&
				after.invocationId === observation.invocationId &&
				(await deps.kernel({ pid: null, attemptId: deps.attemptId })) &&
				(await deps.jobIdle())
			) {
				const reset = await deps.run(
					["systemctl", "reset-failed", OS_STAGE_GUARD_UNIT],
					{ timeoutMs: 10_000 },
				);
				if (reset.exitCode !== 0)
					throw new OsStageError("rauc_recovery_unproven", { cause: reset });
			}
			if (
				(await deps.inspect()).kind !== "absent" ||
				!(await deps.kernel({ pid: null, attemptId: deps.attemptId }))
			)
				throw new OsStageError("rauc_recovery_unproven");
			return;
		}
		await deps.sleep(100);
	} while (deps.now() < deadline);
	throw new OsStageError("rauc_recovery_unproven");
}
