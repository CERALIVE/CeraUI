import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import type { OsAttemptIntentRecoveryPort } from "./os-attempt-intent-recovery.ts";
import { OsStageError } from "./os-stage-error.ts";
import { observeOsStageGuard } from "./os-stage-guard-observation.ts";

export async function assertIntentProducerAbsent(
	port: Pick<OsAttemptIntentRecoveryPort, "readJob" | "readWitness" | "run">,
	attemptId: string,
): Promise<void> {
	if (
		(await port.readJob()) ||
		port.readWitness() ||
		(await observeOsStageGuard(port.run ?? spawnWithTimeout, attemptId))
			.kind !== "absent"
	)
		throw new OsStageError("rauc_recovery_unproven");
}
