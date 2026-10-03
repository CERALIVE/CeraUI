import { OsStageError } from "./os-stage-error.ts";
import type { OsStageJobRecord } from "./os-stage-job-files.ts";
import type { OsStageJobOwner } from "./os-stage-job-owner.ts";
import {
	raucQuiescenceRefusal,
	recoverRaucStage,
} from "./os-stage-recovery.ts";
import type { OsStartupDeps } from "./os-stage-startup.ts";

/** Recovery of a recorded writer after startup has proved guardian ownership. */
export async function recoverOwnedOsStageAtStartup(
	record: OsStageJobRecord,
	owner: OsStageJobOwner,
	deps: OsStartupDeps,
): Promise<void> {
	if (record.launched) await deps.restart();
	let cliGone = !record.launched;
	const proof = await recoverRaucStage(
		{
			baseline: record.baseline,
			processes: new Set(record.processes),
			resources: new Set(record.resources),
		},
		{
			now: deps.now,
			sleep: deps.sleep,
			lockHeld: owner.held,
			cliSettled: () => cliGone,
			observe: async () => {
				cliGone = await deps.cliGone();
				return await deps.observe({
					processes: new Set(record.processes),
					resources: new Set(record.resources),
				});
			},
		},
		record.launched || record.requireNewInstance,
	);
	owner.remember(
		proof,
		record.launched,
		true,
		record.launched || record.requireNewInstance,
	);
	await deps.drain(record.attemptId);
	await deps.sweep();
	const cliSettled = await deps.cliGone();
	const settled = owner.record();
	const ownership = {
		baseline: settled.baseline,
		processes: new Set(settled.processes),
		resources: new Set(settled.resources),
	};
	const finalProof = await deps.observe(ownership);
	const refusal = raucQuiescenceRefusal({
		ownership,
		current: finalProof,
		cliSettled,
		lockHeld: await owner.held(),
		requireNewInstance: record.launched || record.requireNewInstance,
	});
	if (refusal || !finalProof)
		throw new OsStageError("rauc_recovery_unproven", {
			diagnostics: { refusal: refusal ?? "final-observation-missing" },
		});
	await owner.release(finalProof, true);
}
