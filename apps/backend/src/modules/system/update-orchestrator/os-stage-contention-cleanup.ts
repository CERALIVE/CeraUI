import type { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { proveOsGuardKernelOwnership } from "./os-stage-guard-lock.ts";
import type { OsStageGuardObservation } from "./os-stage-guard-observation.ts";
import { osInstallClientsGone } from "./os-stage-install-clients.ts";
import {
	OS_STAGE_GUARD_UNIT,
	type OsStageJobRecord,
	osStageJobSchema,
	retireOsStageJob,
} from "./os-stage-job-files.ts";
import { withOsPhysicalSettlement } from "./os-stage-physical-settlement.ts";
import { readOsStagePrivateOwner } from "./os-stage-private-owner.ts";

export type OsContentionCleanup = {
	readonly record: OsStageJobRecord;
	readonly directory: string;
	readonly uid: number;
	readonly inspect: () => Promise<OsStageGuardObservation>;
	readonly kernel: typeof proveOsGuardKernelOwnership;
	readonly jobIdle: () => Promise<boolean>;
	readonly run: typeof spawnWithTimeout;
	readonly cliGone?: () => Promise<boolean>;
};

export class OsContentionCleanupError extends OsStageError {
	constructor(cause: unknown) {
		super("rauc_recovery_unproven", { cause });
	}
}

export function retireContendedOsStageGuard(
	deps: OsContentionCleanup,
): Promise<void> {
	return withOsPhysicalSettlement(async () => {
		const record = osStageJobSchema.parse(deps.record);
		const owner = await readOsStagePrivateOwner({ ...deps, record });
		const initial = await deps.inspect();
		if (initial.kind !== "terminal" || initial.exitStatus !== 75)
			throw new OsStageError("rauc_recovery_unproven");
		const terminalProof = async () => {
			await owner.assertOwner(record);
			const unit = await deps.inspect();
			if (
				unit.kind !== "terminal" ||
				unit.invocationId !== initial.invocationId ||
				unit.exitStatus !== 75 ||
				!(await (deps.cliGone ?? osInstallClientsGone)()) ||
				!(await deps.jobIdle()) ||
				!(await deps.kernel({ pid: null, attemptId: deps.record.attemptId }))
			)
				throw new OsStageError("rauc_recovery_unproven");
		};
		await terminalProof();
		const stop = await deps.run(["systemctl", "stop", OS_STAGE_GUARD_UNIT], {
			timeoutMs: 10_000,
		});
		if (stop.exitCode !== 0)
			throw new OsStageError("rauc_recovery_unproven", { cause: stop });
		await owner.assertOwner(record);
		if ((await deps.inspect()).kind !== "absent") {
			await terminalProof();
			const reset = await deps.run(
				["systemctl", "reset-failed", OS_STAGE_GUARD_UNIT],
				{ timeoutMs: 10_000 },
			);
			if (reset.exitCode !== 0)
				throw new OsStageError("rauc_recovery_unproven", { cause: reset });
		}
		if (
			(await deps.inspect()).kind !== "absent" ||
			!(await deps.kernel({ pid: null, attemptId: deps.record.attemptId }))
		)
			throw new OsStageError("rauc_recovery_unproven");
		await owner.assertOwner(record);
		await retireOsStageJob(deps.directory);
	}).catch((cause: unknown) => {
		throw new OsContentionCleanupError(cause);
	});
}
