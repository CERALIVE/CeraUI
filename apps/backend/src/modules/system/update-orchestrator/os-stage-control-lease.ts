import { OsStageError } from "./os-stage-error.ts";
import { OS_STAGE_GUARD_HELPER } from "./os-stage-job-files.ts";
import {
	acquireOsOrphanLock,
	type OsOrphanLock,
} from "./os-stage-orphan-lock.ts";

// Cross-process boundary for every stage/recovery controller: fallback control
// ports let a second backend run, and its in-memory fences are its own.
export const OS_STAGE_CONTROL_LOCK = "/run/lock/ceralive-os-stage-control.lock";
export type OsStageControlLease = OsOrphanLock;

/** Borrowing never releases the caller's lease; held() remains a live fence. */
export function borrowOsStageControlLease(
	lease: OsStageControlLease,
): OsStageControlLease {
	return {
		...(lease.pid ? { pid: lease.pid } : {}),
		held: () => lease.held(),
		async [Symbol.asyncDispose]() {
			return;
		},
	};
}

/** A controller already holding the lease is ordinary contention, never unsafe. */
export function acquireOsStageControlLease(): Promise<OsStageControlLease> {
	return acquireOsOrphanLock(
		{ lock: OS_STAGE_CONTROL_LOCK, helper: OS_STAGE_GUARD_HELPER },
		"os_update_lock_held",
	);
}

export async function withOsStageControlLease<T>(
	work: (lease: OsStageControlLease) => Promise<T>,
	acquire = acquireOsStageControlLease,
): Promise<T> {
	await using lease = await acquire();
	if (!lease.held()) throw new OsStageError("rauc_recovery_unproven");
	return await work(lease);
}
