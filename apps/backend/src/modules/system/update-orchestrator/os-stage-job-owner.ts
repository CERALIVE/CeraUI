import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import { type OsStageJobRecord, readOsStageJob } from "./os-stage-job-files.ts";
import { withOsPhysicalSettlement } from "./os-stage-physical-settlement.ts";
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";
import {
	type OsUnlaunchedDeps,
	settleOsStageUnlaunched,
} from "./os-stage-unlaunched.ts";
import { defaultOsUnlaunchedEffects } from "./os-stage-unlaunched-effects.ts";

export type OsStageJobOwner = {
	acquire(): Promise<void>;
	held(): Promise<boolean>;
	remember(
		snapshot: RaucStageSnapshot,
		launched?: boolean,
		cliSettled?: boolean,
		requireNewInstance?: boolean,
	): void;
	beginAttempt(snapshot: RaucStageSnapshot, pair: string): void;
	release(
		snapshot: RaucStageSnapshot,
		pinClean: boolean,
		settle?: () => void,
	): Promise<void>;
	record(): OsStageJobRecord;
	/** False when this owner created no private state; true once settled. */
	settleUnlaunched?(
		control: OsStageControlLease,
		effects?: Partial<OsUnlaunchedDeps>,
	): Promise<boolean>;
};

export type OsOwnedUnlaunched = {
	readonly record: OsStageJobRecord;
	readonly current: OsStageJobRecord;
	readonly control: OsStageControlLease;
	readonly effects: Partial<OsUnlaunchedDeps> &
		Pick<OsUnlaunchedDeps, "directory" | "uid">;
};

/** Settles from the on-disk record, never from the in-memory copy alone. */
export async function settleOwnedUnlaunched(
	input: OsOwnedUnlaunched,
): Promise<void> {
	return withOsPhysicalSettlement(() => settleOwned(input));
}

async function settleOwned(input: OsOwnedUnlaunched): Promise<void> {
	const disk = await readOsStageJob(input.effects.directory, input.effects.uid);
	if (
		!disk ||
		disk.attemptId !== input.record.attemptId ||
		disk.launched ||
		input.current.launched
	)
		throw new OsStageError("rauc_recovery_unproven");
	// This process is the producer and it is unwinding; nothing can dispatch.
	await settleOsStageUnlaunched(disk, {
		...defaultOsUnlaunchedEffects,
		producerPresent: () => false,
		...input.effects,
		control: input.control,
	});
}
