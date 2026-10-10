import {
	assertStageDeadline,
	createStageDeadline,
	withinStageDeadline,
} from "./os-stage-deadline.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { OsStageJobRecord } from "./os-stage-job-files.ts";
import type { OsStageJobOwner } from "./os-stage-job-owner.ts";
import { observeQuiescence } from "./os-stage-quiescence-wait.ts";
import {
	RAUC_RECOVERY_DEADLINE_MS,
	recoverRaucStage,
} from "./os-stage-recovery.ts";
import type { OsStartupDeps } from "./os-stage-startup.ts";

/** Recovery of a recorded writer after startup has proved guardian ownership. */
export async function recoverOwnedOsStageAtStartup(
	record: OsStageJobRecord,
	owner: OsStageJobOwner,
	deps: OsStartupDeps,
): Promise<void> {
	const deadline = deps.now() + RAUC_RECOVERY_DEADLINE_MS;
	const budget = createStageDeadline({ deadline, now: deps.now });
	const read = <T>(work: () => Promise<T>) => withinStageDeadline(budget, work);
	if (record.launched) await read(deps.restart);
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
			lockHeld: async () => {
				await owner.assertAuthority?.();
				return owner.held();
			},
			deadline,
			invalidate: budget.invalidate,
			cliSettled: () => cliGone,
			observe: async () => {
				const gone = await read(deps.cliGone);
				const snapshot = await read(() =>
					deps.observe({
						processes: new Set(record.processes),
						resources: new Set(record.resources),
					}),
				);
				assertStageDeadline(budget);
				cliGone = gone;
				return snapshot;
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
	await read(() => deps.drain(record.attemptId));
	await read(deps.sweep);
	const settled = owner.record();
	const ownership = {
		baseline: settled.baseline,
		processes: new Set(settled.processes),
		resources: new Set(settled.resources),
	};
	const finalProof = await observeQuiescence({
		ownership,
		observe: () => deps.observe(ownership),
		cliSettled: deps.cliGone,
		lockHeld: owner.held,
		requireNewInstance: record.launched || record.requireNewInstance,
		wait: {
			...deps,
			deadline,
			invalidate: budget.invalidate,
			assert: async () => {
				await owner.assertAuthority?.();
				if (deps.controlHeld?.() === false || !(await owner.held()))
					throw new OsStageError("rauc_recovery_unproven");
			},
		},
	});
	await read(() =>
		owner.release(
			finalProof,
			true,
			() => {
				assertStageDeadline(budget);
				if (deps.controlHeld?.() === false || deps.now() >= deadline)
					throw new OsStageError("rauc_recovery_unproven");
			},
			budget,
		),
	);
}
