import type { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import {
	assertStageDeadline,
	type StageDeadline,
	withinStageDeadline,
} from "./os-stage-deadline.ts";
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
	readonly budget?: StageDeadline;
}): Promise<void> {
	const deadline = Math.min(
		deps.now() + 10_000,
		deps.budget?.deadline ?? Infinity,
	);
	const budget = deps.budget ?? { deadline, now: deps.now };
	const read = <T>(work: () => Promise<T>) => withinStageDeadline(budget, work);
	do {
		const observation = await read(deps.inspect);
		if (observation.kind === "absent") {
			if (
				!(await read(() =>
					deps.kernel({ pid: null, attemptId: deps.attemptId }),
				))
			)
				throw new OsStageError("rauc_recovery_unproven");
			return;
		}
		if (observation.kind === "terminal" && observation.cleanExit) {
			if (
				!(await read(() =>
					deps.kernel({ pid: null, attemptId: deps.attemptId }),
				)) ||
				!(await read(deps.jobIdle))
			)
				throw new OsStageError("rauc_recovery_unproven");
			assertStageDeadline(budget);
			const stopped = await read(() =>
				deps.run(["systemctl", "stop", OS_STAGE_GUARD_UNIT], {
					timeoutMs: 10_000,
				}),
			);
			if (stopped.exitCode !== 0)
				throw new OsStageError("rauc_recovery_unproven", { cause: stopped });
			const after = await read(deps.inspect);
			if (
				after.kind === "terminal" &&
				after.invocationId === observation.invocationId &&
				(await read(() =>
					deps.kernel({ pid: null, attemptId: deps.attemptId }),
				)) &&
				(await read(deps.jobIdle))
			) {
				assertStageDeadline(budget);
				const reset = await read(() =>
					deps.run(["systemctl", "reset-failed", OS_STAGE_GUARD_UNIT], {
						timeoutMs: 10_000,
					}),
				);
				if (reset.exitCode !== 0)
					throw new OsStageError("rauc_recovery_unproven", { cause: reset });
			}
			if (
				(await read(deps.inspect)).kind !== "absent" ||
				!(await read(() =>
					deps.kernel({ pid: null, attemptId: deps.attemptId }),
				))
			)
				throw new OsStageError("rauc_recovery_unproven");
			return;
		}
		await read(() => deps.sleep(Math.min(100, deadline - deps.now())));
	} while (deps.now() < deadline);
	throw new OsStageError("rauc_recovery_unproven");
}
