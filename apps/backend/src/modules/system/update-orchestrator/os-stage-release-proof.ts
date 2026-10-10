import {
	type StageDeadline,
	withinStageDeadline,
} from "./os-stage-deadline.ts";
import { OsStageError } from "./os-stage-error.ts";
import { osInstallClientsGone } from "./os-stage-install-clients.ts";
import type { OsStageJobRecord } from "./os-stage-job-files.ts";
import { withOsPhysicalSettlement } from "./os-stage-physical-settlement.ts";
import {
	type RaucStageSnapshot,
	raucQuiescenceRefusal,
} from "./os-stage-recovery.ts";

export function proveOsStageRelease(input: {
	readonly record: OsStageJobRecord;
	readonly snapshot: RaucStageSnapshot;
	readonly pinClean: boolean;
	readonly held: () => Promise<boolean>;
	readonly cliGone?: () => Promise<boolean>;
	/** Current private-directory provenance; throws on any drift. */
	readonly provenance: () => Promise<void>;
	readonly budget?: StageDeadline;
}): Promise<void> {
	const read = <T>(work: () => Promise<T>) =>
		input.budget ? withinStageDeadline(input.budget, work) : work();
	return withOsPhysicalSettlement(async () => {
		const refusal = raucQuiescenceRefusal({
			ownership: {
				baseline: input.record.baseline,
				processes: new Set(input.record.processes),
				resources: new Set(input.record.resources),
			},
			current: input.snapshot,
			cliSettled: input.record.cliSettled,
			lockHeld: await read(input.held),
			requireNewInstance: input.record.requireNewInstance,
		});
		if (
			refusal ||
			!input.pinClean ||
			!(await read(input.cliGone ?? osInstallClientsGone))
		)
			throw new OsStageError("rauc_recovery_unproven", {
				diagnostics: {
					refusal:
						refusal ??
						(input.pinClean
							? "install-client-present"
							: "pin-teardown-unproven"),
				},
			});
		await read(input.provenance);
	});
}
