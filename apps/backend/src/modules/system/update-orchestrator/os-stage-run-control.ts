import { currentLifecycleHolder } from "../../streaming/lifecycle-admission.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import { OsContentionCleanupError } from "./os-stage-contention-cleanup.ts";
import {
	acquireOsStageControlLease,
	borrowOsStageControlLease,
	type OsStageControlLease,
} from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import type { OsStageJobOwner } from "./os-stage-job-owner.ts";
import { withOsPhysicalSettlement } from "./os-stage-physical-settlement.ts";
import type { OsStageRunControl } from "./os-stage-run.ts";
import type { OsUnlaunchedDeps } from "./os-stage-unlaunched.ts";

export function assertOsStageToken(control: OsStageRunControl): void {
	if (
		control.signal.aborted ||
		control.canCommit?.() === false ||
		getIsStreaming() ||
		currentLifecycleHolder() === "streaming"
	)
		throw new OsStageError("os_stage_cancelled_for_stream");
}

/** Lease first; the dispatch fence drops before the lease is surrendered. */
export async function withOsStageRunControl<T>(
	control: OsStageRunControl & {
		readonly controlLease?: OsStageControlLease;
	},
	acquire: typeof acquireOsStageControlLease | undefined,
	work: (guarded: OsStageRunControl, lease: OsStageControlLease) => Promise<T>,
): Promise<T> {
	await using lease = control.controlLease
		? borrowOsStageControlLease(control.controlLease)
		: await (acquire ?? acquireOsStageControlLease)();
	if (!lease.held()) throw new OsStageError("rauc_recovery_unproven");
	let dispatchAllowed = true;
	try {
		return await work(
			{
				...control,
				canCommit: () =>
					dispatchAllowed && lease.held() && control.canCommit?.() !== false,
			},
			lease,
		);
	} finally {
		dispatchAllowed = false;
	}
}

export type OsUnlaunchedFailure = {
	readonly owner: OsStageJobOwner;
	readonly lease: OsStageControlLease;
	readonly effects: Partial<OsUnlaunchedDeps>;
};

/** Never adopts state this attempt did not create; contention is already settled. */
export async function acquireOrSettleOsStage(
	input: OsUnlaunchedFailure,
): Promise<void> {
	try {
		await input.owner.acquire();
	} catch (cause) {
		if (cause instanceof OsContentionCleanupError) throw cause;
		if (cause instanceof OsStageError && cause.reason === "os_update_lock_held")
			throw cause;
		await withOsPhysicalSettlement(async () => {
			if (!(await input.owner.settleUnlaunched?.(input.lease, input.effects)))
				throw cause;
		});
		throw new OsStageError("rauc_install_failed", { cause });
	}
}

/** A proved never-launched attempt becomes a retryable operator failure. */
export async function settleUnlaunchedOsStageFailure(
	input: OsUnlaunchedFailure,
	cause: unknown,
): Promise<void> {
	const settle = input.owner.settleUnlaunched;
	if (input.owner.record().launched || !settle) return;
	await withOsPhysicalSettlement(async () => {
		if (!(await settle(input.lease, input.effects)))
			throw new OsStageError("rauc_recovery_unproven", { cause });
	});
	if (cause instanceof OsStageError && cause.mode !== "unsafe") throw cause;
	throw new OsStageError("rauc_install_failed", { cause });
}
