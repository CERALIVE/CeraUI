import { requireAdmissionSnapshot } from "./os-stage-admission-snapshot.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { OsStageJobRecord } from "./os-stage-job-files.ts";
import {
	type RaucStageSnapshot,
	raucQuiescenceRefusal,
} from "./os-stage-recovery.ts";

export function proveOsStageUnlaunched(input: {
	readonly record: OsStageJobRecord;
	readonly current: RaucStageSnapshot | null;
	readonly clientsGone: boolean;
	readonly lockHeld: boolean;
	readonly outcomeAbsent: boolean;
}): RaucStageSnapshot {
	const { record } = input;
	requireAdmissionSnapshot(record.baseline);
	const refusal = raucQuiescenceRefusal({
		ownership: {
			baseline: record.baseline,
			processes: new Set(record.processes),
			resources: new Set(record.resources),
		},
		current: input.current,
		cliSettled: record.cliSettled && input.clientsGone,
		lockHeld: input.lockHeld,
		requireNewInstance: false,
	});
	if (
		record.launched ||
		!record.cliSettled ||
		record.requireNewInstance ||
		!input.outcomeAbsent ||
		record.baseline.processes.length !== 1 ||
		record.baseline.processes[0] !== record.baseline.instance ||
		refusal ||
		!input.current ||
		input.current.instance !== record.baseline.instance ||
		JSON.stringify([...input.current.processes].sort()) !==
			JSON.stringify([...record.baseline.processes].sort()) ||
		record.resources.length ||
		record.processes.some((id) => id !== record.baseline.instance)
	)
		throw new OsStageError("rauc_recovery_unproven", {
			diagnostics: { refusal: refusal ?? "unlaunched-provenance-unproven" },
		});
	return input.current;
}
