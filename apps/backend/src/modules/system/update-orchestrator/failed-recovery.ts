import { isDeepStrictEqual } from "node:util";
import type { SlotSyncProbeState } from "./lock.ts";
import { notifyUpdate } from "./notifications.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import {
	type PackageRecoveryEvidence,
	packageRecoveryProven,
} from "./package-recovery-evidence.ts";
import { toPersisted } from "./persistence.ts";
import { reduceOrchestrator } from "./reducer.ts";
import type { RootSlotStatus } from "./slot-status.ts";
import type { SlotSyncEvidence } from "./slot-sync-gate.ts";
import {
	isRecordedSyncFailure,
	laterSyncProven,
	syncUnitClean,
} from "./sync-failure-recovery.ts";
import type { OrchestratorState } from "./types.ts";

export interface FailedRecoveryPort {
	readonly snapshot: () => OrchestratorState;
	readonly current: () => boolean;
	readonly acquireControl: () => Promise<OsStageControlLease>;
	readonly acquireUpdateLock: () => Promise<OsStageControlLease>;
	readonly readPersisted: () => Promise<OrchestratorState | null>;
	readonly readPackageEvidence: () => Promise<PackageRecoveryEvidence>;
	readonly clearPending: () => Promise<void>;
	readonly persist: (state: OrchestratorState) => void;
	readonly adopt: (state: OrchestratorState) => void;
	readonly now: () => number;
	readonly inspectSync: () => Promise<SlotSyncProbeState>;
	readonly readSyncEvidence: () => Promise<SlotSyncEvidence>;
	readonly readSlots: () => Promise<readonly RootSlotStatus[]>;
	readonly readVersion: () => Promise<string | undefined>;
}

export async function recoverFailedUpdate(
	port: FailedRecoveryPort,
): Promise<boolean> {
	const before = port.snapshot();
	if (before.phase !== "failed") return false;
	if (
		before.osStageRecovery?.mode === "unsafe" ||
		before.osStageRecovery?.activeAttemptId
	)
		return false;
	const packages = before.failureReason === "commit_unit_absent_on_resume";
	if (!packages && !isRecordedSyncFailure(before.failureReason)) return false;
	if (packages && !before.packageAttempt) return false;
	await using lease = await port.acquireControl();
	await using updateLock = await port.acquireUpdateLock();
	const persisted = await port.readPersisted();
	if (
		!persisted ||
		!isDeepStrictEqual(toPersisted(before), toPersisted(persisted))
	)
		return false;
	if (packages) {
		if (!packageRecoveryProven(before, await port.readPackageEvidence()))
			return false;
	} else {
		if (!syncUnitClean(await port.inspectSync())) return false;
		const evidence = await port.readSyncEvidence();
		const slots = await port.readSlots();
		const version = await port.readVersion();
		if (
			!laterSyncProven({
				evidence,
				slots,
				version,
				failureAt: before.enteredAt,
				now: port.now(),
			})
		)
			return false;
		if (!syncUnitClean(await port.inspectSync())) return false;
	}
	if (
		!lease.held() ||
		!updateLock.held() ||
		!port.current() ||
		port.snapshot() !== before
	)
		return false;
	if (packages) await port.clearPending();
	if (
		!lease.held() ||
		!updateLock.held() ||
		!port.current() ||
		port.snapshot() !== before
	)
		return false;
	const next = reduceOrchestrator(before, {
		type: packages
			? "COMMIT_RESUME_SETTLED_CONSISTENT"
			: "SYNC_FAILURE_SUPERSEDED",
		now: port.now(),
	});
	port.persist(next);
	port.adopt(next);
	if (next.recoveredNotice) notifyUpdate(next.recoveredNotice);
	return true;
}
