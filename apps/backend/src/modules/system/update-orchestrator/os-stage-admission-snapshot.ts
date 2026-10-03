import { OsStageError } from "./os-stage-error.ts";
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";

export function requireAdmissionSnapshot(
	snapshot: RaucStageSnapshot | null,
	baseline?: RaucStageSnapshot,
): RaucStageSnapshot {
	if (
		!snapshot?.active ||
		snapshot.operation !== "idle" ||
		snapshot.resources.length ||
		snapshot.processes.some((id) => id !== snapshot.instance) ||
		!snapshot.bootedHealthy ||
		!snapshot.targetInactive ||
		!snapshot.bootPrimary ||
		snapshot.bootPrimary !== snapshot.bootedSlot ||
		snapshot.bootPrimary === snapshot.targetSlot ||
		snapshot.activationArmed ||
		(baseline !== undefined &&
			(snapshot.bootId !== baseline.bootId ||
				snapshot.bootPrimary !== baseline.bootPrimary ||
				snapshot.bootedSlot !== baseline.bootedSlot ||
				snapshot.bootedDevice !== baseline.bootedDevice ||
				snapshot.targetSlot !== baseline.targetSlot ||
				snapshot.targetDevice !== baseline.targetDevice))
	)
		throw new OsStageError("rauc_recovery_unproven", {
			diagnostics: { refusal: "stage-admission-unproven" },
		});
	return snapshot;
}
